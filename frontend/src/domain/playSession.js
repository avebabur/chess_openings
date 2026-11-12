/* A game against the engine from any position.
 *
 * Pure state and rules only: the hook (usePlaySession) does the network and the
 * timers. A session is a start position plus the moves played from it; every
 * derived fact (whose turn, the result) is recomputed from those, so taking a
 * move back is just dropping it from the list.
 */
import { Chess } from 'chess.js'

export const PLAY_STATUS = {
  USER_TURN: 'userTurn',
  ENGINE_THINKING: 'engineThinking',
  OVER: 'over',
}

// The Lichess tablebase covers seven pieces or fewer and no castling rights.
const TABLEBASE_MAX_PIECES = 7

export function pieceCount(fen) {
  return ((fen || '').split(' ')[0].match(/[a-zA-Z]/g) || []).length
}

export function tablebaseCovers(fen) {
  const fields = (fen || '').split(' ')
  return pieceCount(fen) <= TABLEBASE_MAX_PIECES && (fields[2] || '-') === '-'
}

function colorOfTurn(fen) {
  return fen?.split(' ')[1] === 'b' ? 'black' : 'white'
}

const FEN_DEFAULTS = ['', 'w', '-', '-', '0', '1']

/**
 * A pasted position -> `{ fen }` ready to play from, or `{ error }` saying what
 * is wrong with it. Missing trailing fields are filled in, so the board part
 * alone ("8/8/8/4k3/8/4K3/4P3/8") or board + side to move is enough.
 *
 * chess.js checks the shape and the kings. One thing it lets through is a
 * position where the side that just moved left its own king in check, which no
 * game can reach and which makes Stockfish 19 quit, so that is checked here.
 */
export function parseStartFen(text) {
  const fields = (text || '').trim().split(/\s+/).filter(Boolean)
  if (!fields.length) return { error: '' }
  if (fields.length > 6) return { error: 'That has too many parts to be a FEN.' }
  const fen = FEN_DEFAULTS.map((fallback, i) => fields[i] ?? fallback).join(' ')

  let game
  try {
    game = new Chess(fen)
  } catch (err) {
    const detail = String(err?.message || '').replace(/^Invalid FEN:\s*/i, '')
    return { error: detail ? `Not a valid position: ${detail}` : 'Not a valid position.' }
  }

  const mover = game.turn()
  const waiting = mover === 'w' ? 'b' : 'w'
  const king = game.board().flat().find(piece => piece && piece.type === 'k' && piece.color === waiting)
  if (king && game.isAttacked(king.square, mover)) {
    const side = waiting === 'w' ? 'White' : 'Black'
    return { error: `${side}'s king is in check but it is not ${side}'s move.` }
  }
  if (gameResult(game.fen(), [])) return { error: 'That position is already over.' }
  return { fen: game.fen() }
}

/** Plies played before the start position, so move numbers match the FEN. */
export function startPlyOf(fen) {
  const fields = (fen || '').split(' ')
  const fullmove = Math.max(1, Number(fields[5]) || 1)
  return (fullmove - 1) * 2 + (fields[1] === 'b' ? 1 : 0)
}

/**
 * How the game stands after `sans` were played from `startFen`: null while it
 * is still going, otherwise the winner (`white`/`black`/null for a draw) and why.
 * Replayed from the start so a threefold repetition is seen.
 */
export function gameResult(startFen, sans) {
  let game
  try {
    game = new Chess(startFen)
    for (const san of sans) game.move(san)
  } catch {
    return null
  }
  if (game.isCheckmate()) {
    return { winner: game.turn() === 'w' ? 'black' : 'white', reason: 'checkmate' }
  }
  if (game.isStalemate()) return { winner: null, reason: 'stalemate' }
  if (game.isInsufficientMaterial()) return { winner: null, reason: 'insufficient material' }
  if (game.isThreefoldRepetition()) return { winner: null, reason: 'threefold repetition' }
  if (game.isDrawByFiftyMoves()) return { winner: null, reason: 'the fifty-move rule' }
  return null
}

/**
 * What the tablebase says about the move `uci`, played in the position `table`
 * describes. Null when the tablebase cannot judge it.
 *
 * `kind` is one of:
 *   kept-win, kept-draw      the result did not change
 *   lost-anyway              the position was already lost
 *   win-to-draw, win-to-loss, draw-to-loss   the move gave something away
 */
export function verdictForMove(table, uci) {
  if (!table?.available || !table.outcome) return null
  const played = table.moves?.find(move => move.uci === uci)
  if (!played?.outcome) return null
  const best = table.moves[0]
  const before = table.outcome
  const after = played.outcome

  let kind
  if (before === after) {
    kind = before === 'win' ? 'kept-win' : before === 'draw' ? 'kept-draw' : 'lost-anyway'
  } else if (before === 'win') {
    kind = after === 'draw' ? 'win-to-draw' : 'win-to-loss'
  } else if (before === 'draw' && after === 'loss') {
    kind = 'draw-to-loss'
  } else {
    // The tablebase cannot report a move that improves on perfect play.
    return null
  }

  const mistake = before !== after
  // dtm counts plies to mate for the mover, starting after this move.
  const mateIn = after === 'win' && Number.isInteger(played.dtm)
    ? Math.ceil(Math.abs(played.dtm) / 2)
    : null
  const bestMateIn = Number.isInteger(best?.dtm) && best.outcome === 'win'
    ? Math.ceil(Math.abs(best.dtm) / 2)
    : null
  return {
    kind,
    mistake,
    before,
    after,
    san: played.san,
    bestSan: mistake ? best.san : null,
    mateIn,
    // Only meaningful for a move that kept the win.
    fastest: kind === 'kept-win' && mateIn != null && bestMateIn != null ? mateIn <= bestMateIn : null,
    fastestSan: kind === 'kept-win' && best.uci !== uci ? best.san : null,
    fastestMateIn: bestMateIn,
    fiftyMove: Boolean(played.fifty_move),
  }
}

export function createPlaySession({ fen, userColor, seconds = 1, label = '' }) {
  const session = {
    startFen: fen,
    userColor: userColor === 'black' ? 'black' : 'white',
    seconds,
    label,
    moves: [],
    error: null,
  }
  return withStatus(session)
}

export function playFen(session) {
  return session.moves.length ? session.moves.at(-1).fenAfter : session.startFen
}

export function playSans(session) {
  return session.moves.map(move => move.san)
}

export function playLastMove(session) {
  const last = session.moves.at(-1)
  return last ? [last.from, last.to] : null
}

function withStatus(session) {
  const result = gameResult(session.startFen, playSans(session))
  if (result) return { ...session, result, status: PLAY_STATUS.OVER }
  const userToMove = colorOfTurn(playFen(session)) === session.userColor
  return {
    ...session,
    result: null,
    status: userToMove ? PLAY_STATUS.USER_TURN : PLAY_STATUS.ENGINE_THINKING,
  }
}

function moveEntry(by, move, extra = {}) {
  return {
    by,
    san: move.san,
    uci: `${move.from}${move.to}${move.move?.promotion || ''}`,
    from: move.from,
    to: move.to,
    fenBefore: extra.fenBefore,
    fenAfter: move.fenAfter,
    source: extra.source || null,
    verdict: null,
  }
}

export function playReducer(state, action) {
  switch (action.type) {
    case 'start':
      return createPlaySession(action.payload)
    case 'stop':
      return null
    case 'restart':
      return state ? withStatus({ ...state, moves: [], error: null }) : state
    case 'userMove': {
      if (!state || state.status !== PLAY_STATUS.USER_TURN) return state
      const entry = moveEntry('user', action.move, { fenBefore: playFen(state) })
      return withStatus({ ...state, moves: [...state.moves, entry], error: null })
    }
    case 'engineMove': {
      if (!state || state.status !== PLAY_STATUS.ENGINE_THINKING) return state
      // A reply that was computed for a position we have since left (take back,
      // restart) must not be played into the new one.
      if (action.fenBefore !== playFen(state)) return state
      const entry = moveEntry('engine', action.move, { fenBefore: action.fenBefore, source: action.source })
      return withStatus({ ...state, moves: [...state.moves, entry], error: null })
    }
    case 'engineError':
      if (!state || state.status !== PLAY_STATUS.ENGINE_THINKING) return state
      if (action.fenBefore !== playFen(state)) return state
      return { ...state, error: action.message || 'Stockfish did not answer' }
    case 'retry':
      return state?.error ? { ...state, error: null } : state
    case 'verdict': {
      if (!state) return state
      const index = state.moves.findIndex(move => (
        move.by === 'user' && move.fenBefore === action.fenBefore && move.uci === action.uci
      ))
      if (index < 0) return state
      const moves = state.moves.slice()
      moves[index] = { ...moves[index], verdict: action.verdict }
      return { ...state, moves }
    }
    case 'takeBack': {
      if (!state || !state.moves.some(move => move.by === 'user')) return state
      // Drop the engine's reply (if it has replied) and the user move before it.
      const moves = state.moves.slice()
      while (moves.length && moves.at(-1).by !== 'user') moves.pop()
      moves.pop()
      return withStatus({ ...state, moves, error: null })
    }
    default:
      return state
  }
}

/** The most recent user move that has a verdict, for the status card. */
export function latestVerdict(session) {
  for (let i = session.moves.length - 1; i >= 0; i -= 1) {
    const move = session.moves[i]
    if (move.by === 'user') return move.verdict ? { ...move.verdict, ply: i } : null
  }
  return null
}

export function resultText(session) {
  const { result, userColor } = session
  if (!result) return ''
  if (!result.winner) return `Draw by ${result.reason}`
  return result.winner === userColor ? 'You won by checkmate' : 'Stockfish won by checkmate'
}
