import { useCallback, useEffect, useReducer, useRef } from 'react'
import { api } from '../api'
import { makeMove } from '../domain/chessLine'
import {
  PLAY_STATUS,
  playFen,
  playReducer,
  tablebaseCovers,
  verdictForMove,
} from '../domain/playSession'
import { castleUci } from '../domain/practiceGoal'
import { playGameEndSound, playStepSound } from '../sounds'

// A tablebase reply comes back in a few milliseconds. Without a floor the
// opponent's piece would start moving while yours is still gliding (300ms).
const MIN_REPLY_MS = 450

/**
 * A game against Stockfish from any position.
 *
 * Two things happen off the board:
 *   - On the engine's turn, ask the backend for its move (tablebase-perfect with
 *     seven or fewer pieces, Stockfish otherwise) and play it.
 *   - For every position you are about to move in, fetch the tablebase so your
 *     move can be judged. The lookup is started as soon as the position appears
 *     and is awaited when you move, so a premove still gets its verdict.
 */
export function usePlaySession() {
  const [session, dispatch] = useReducer(playReducer, null)
  // fen -> Promise<table | null>. Reused across take-backs and restarts.
  const tables = useRef(new Map())

  const tableFor = useCallback((fen) => {
    if (!tablebaseCovers(fen)) return Promise.resolve(null)
    const known = tables.current.get(fen)
    if (known) return known
    const request = api.get('/tablebase', { params: { fen } })
      .then(res => res.data)
      .catch(() => {
        // Let a later visit to this position try again.
        tables.current.delete(fen)
        return null
      })
    tables.current.set(fen, request)
    return request
  }, [])

  const fen = session ? playFen(session) : null
  const status = session?.status ?? null
  const seconds = session?.seconds ?? 1
  const error = session?.error ?? null
  const scripted = session?.script ? session.script[session.moves.length] : null
  const hasScript = Boolean(session?.script)

  // Warm the tablebase for the position the user is looking at.
  useEffect(() => {
    if (status === PLAY_STATUS.USER_TURN && fen) tableFor(fen)
  }, [status, fen, tableFor])

  // The engine's move.
  useEffect(() => {
    if (status !== PLAY_STATUS.ENGINE_THINKING || !fen || error) return undefined
    if (hasScript) {
      // A puzzle: the reply is already known, so nothing is asked of the engine.
      const play = uci => makeMove(fen, uci.slice(0, 2), uci.slice(2, 4), uci[4] || 'q')
      // If the move is not legal as written it may be a castle in the
      // king-takes-rook form.
      const reply = scripted ? (play(scripted) || play(castleUci(scripted))) : null
      const wait = window.setTimeout(() => {
        if (!reply) {
          dispatch({ type: 'engineError', fenBefore: fen, message: 'This puzzle has no reply to that move' })
          return
        }
        playStepSound(reply.san)
        dispatch({ type: 'engineMove', fenBefore: fen, move: reply, source: 'script' })
      }, MIN_REPLY_MS)
      return () => window.clearTimeout(wait)
    }
    const controller = new AbortController()
    const started = performance.now()
    let timer = null

    api.post('/play/reply', { fen, seconds }, { signal: controller.signal })
      .then((res) => {
        const { uci, source } = res.data || {}
        // How the position you just left was rated; a practice goal may end
        // the game here, which also cancels the reply below.
        dispatch({ type: 'assessment', fen, reply: res.data })
        if (controller.signal.aborted) return
        const move = uci ? makeMove(fen, uci.slice(0, 2), uci.slice(2, 4), uci[4] || 'q') : null
        if (!move) throw new Error('Stockfish returned a move that is not legal here')
        const wait = Math.max(0, MIN_REPLY_MS - (performance.now() - started))
        timer = window.setTimeout(() => {
          playStepSound(move.san)
          dispatch({ type: 'engineMove', fenBefore: fen, move, source })
        }, wait)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        const detail = err.response?.data?.detail
        dispatch({
          type: 'engineError',
          fenBefore: fen,
          message: typeof detail === 'string' ? detail : (err.message || 'Stockfish did not answer'),
        })
      })

    return () => {
      controller.abort()
      if (timer) window.clearTimeout(timer)
    }
  }, [status, fen, seconds, error, hasScript, scripted])

  useEffect(() => {
    if (status === PLAY_STATUS.OVER) playGameEndSound()
  }, [status])

  const start = useCallback((payload) => dispatch({ type: 'start', payload }), [])
  const stop = useCallback(() => dispatch({ type: 'stop' }), [])
  const restart = useCallback(() => dispatch({ type: 'restart' }), [])
  const takeBack = useCallback(() => dispatch({ type: 'takeBack' }), [])
  const retry = useCallback(() => dispatch({ type: 'retry' }), [])
  const playOn = useCallback(() => dispatch({ type: 'playOn' }), [])
  const setSeconds = useCallback(seconds => dispatch({ type: 'setSeconds', seconds }), [])

  /** Record a legal move the user made (a `makeMove` result) and judge it. */
  const userMove = useCallback((move) => {
    if (!session || session.status !== PLAY_STATUS.USER_TURN) return
    const fenBefore = playFen(session)
    const uci = `${move.from}${move.to}${move.move?.promotion || ''}`
    dispatch({ type: 'userMove', move })
    tableFor(fenBefore).then((table) => {
      const verdict = verdictForMove(table, uci)
      if (verdict) dispatch({ type: 'verdict', fenBefore, uci, verdict })
    })
  }, [session, tableFor])

  return { session, start, stop, restart, takeBack, retry, playOn, setSeconds, userMove }
}
