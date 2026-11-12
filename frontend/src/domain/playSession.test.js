import { describe, expect, it } from 'vitest'
import { makeMove } from './chessLine'
import {
  PLAY_STATUS,
  createPlaySession,
  gameResult,
  latestVerdict,
  parseStartFen,
  pieceCount,
  playFen,
  playReducer,
  playSans,
  resultText,
  startPlyOf,
  tablebaseCovers,
  verdictForMove,
} from './playSession'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
// Lucena: White to move and winning.
const LUCENA = '6K1/4k1P1/8/8/8/7r/8/5R2 w - - 0 1'
// What the backend returns for it (mover's point of view, best first).
const LUCENA_TABLE = {
  available: true,
  outcome: 'win',
  moves: [
    { uci: 'f1e1', san: 'Re1+', outcome: 'win', dtm: 40 },
    { uci: 'f1a1', san: 'Ra1', outcome: 'win', dtm: 42 },
    { uci: 'f1h1', san: 'Rh1', outcome: 'draw', dtm: 0 },
    { uci: 'f1f3', san: 'Rf3', outcome: 'loss', dtm: -35 },
  ],
}

const user = (state, from, to) => playReducer(state, { type: 'userMove', move: makeMove(playFen(state), from, to) })
const engine = (state, from, to, source = 'stockfish') => {
  const fenBefore = playFen(state)
  return playReducer(state, { type: 'engineMove', fenBefore, move: makeMove(fenBefore, from, to), source })
}

describe('tablebase coverage', () => {
  it('needs seven or fewer pieces and no castling rights', () => {
    expect(pieceCount(START)).toBe(32)
    expect(tablebaseCovers(START)).toBe(false)
    expect(tablebaseCovers(LUCENA)).toBe(true)
    expect(tablebaseCovers('4k3/8/8/8/8/8/8/R3K3 w Q - 0 1')).toBe(false)
  })
})

describe('verdictForMove', () => {
  it('praises the fastest win and says when a slower one was played', () => {
    expect(verdictForMove(LUCENA_TABLE, 'f1e1')).toMatchObject({
      kind: 'kept-win', mistake: false, mateIn: 20, fastest: true, fastestSan: null,
    })
    expect(verdictForMove(LUCENA_TABLE, 'f1a1')).toMatchObject({
      kind: 'kept-win', mistake: false, mateIn: 21, fastest: false, fastestSan: 'Re1+', fastestMateIn: 20,
    })
  })

  it('names the move that would have kept the result', () => {
    expect(verdictForMove(LUCENA_TABLE, 'f1h1')).toMatchObject({
      kind: 'win-to-draw', mistake: true, bestSan: 'Re1+', san: 'Rh1',
    })
    expect(verdictForMove(LUCENA_TABLE, 'f1f3')).toMatchObject({ kind: 'win-to-loss', mistake: true })
  })

  it('covers drawn and lost positions', () => {
    const drawn = { available: true, outcome: 'draw', moves: [
      { uci: 'a1a2', san: 'Ka2', outcome: 'draw' }, { uci: 'a1b1', san: 'Kb1', outcome: 'loss' },
    ] }
    expect(verdictForMove(drawn, 'a1a2')).toMatchObject({ kind: 'kept-draw', mistake: false })
    expect(verdictForMove(drawn, 'a1b1')).toMatchObject({ kind: 'draw-to-loss', bestSan: 'Ka2' })
    const lost = { available: true, outcome: 'loss', moves: [{ uci: 'a1a2', san: 'Ka2', outcome: 'loss' }] }
    expect(verdictForMove(lost, 'a1a2')).toMatchObject({ kind: 'lost-anyway', mistake: false })
  })

  it('says nothing when the tablebase cannot judge the move', () => {
    expect(verdictForMove(null, 'f1e1')).toBeNull()
    expect(verdictForMove({ available: false, reason: 'pieces' }, 'f1e1')).toBeNull()
    expect(verdictForMove(LUCENA_TABLE, 'a1a2')).toBeNull()
    expect(verdictForMove({ ...LUCENA_TABLE, moves: [{ uci: 'f1e1', san: 'Re1+', outcome: null }] }, 'f1e1')).toBeNull()
  })
})

describe('play session', () => {
  it('starts on the user turn or the engine turn depending on the colour chosen', () => {
    expect(createPlaySession({ fen: START, userColor: 'white' }).status).toBe(PLAY_STATUS.USER_TURN)
    expect(createPlaySession({ fen: START, userColor: 'black' }).status).toBe(PLAY_STATUS.ENGINE_THINKING)
    expect(createPlaySession({ fen: LUCENA, userColor: 'black' }).status).toBe(PLAY_STATUS.ENGINE_THINKING)
  })

  it('alternates turns and ignores a move made out of turn', () => {
    let state = createPlaySession({ fen: START, userColor: 'white' })
    state = user(state, 'e2', 'e4')
    expect(state.status).toBe(PLAY_STATUS.ENGINE_THINKING)
    expect(user(state, 'd2', 'd4')).toBe(state)
    state = engine(state, 'e7', 'e5')
    expect(state.status).toBe(PLAY_STATUS.USER_TURN)
    expect(playSans(state)).toEqual(['e4', 'e5'])
  })

  it('drops an engine reply that was computed for a position already left', () => {
    let state = createPlaySession({ fen: START, userColor: 'white' })
    state = user(state, 'e2', 'e4')
    const staleFen = playFen(state)
    const reply = makeMove(staleFen, 'e7', 'e5')
    state = playReducer(state, { type: 'takeBack' })
    state = user(state, 'd2', 'd4')
    const after = playReducer(state, { type: 'engineMove', fenBefore: staleFen, move: reply, source: 'stockfish' })
    expect(after).toBe(state)
    expect(playSans(after)).toEqual(['d4'])
  })

  it('takes back your move together with the reply to it', () => {
    let state = createPlaySession({ fen: START, userColor: 'white' })
    state = engine(user(state, 'e2', 'e4'), 'e7', 'e5')
    state = user(state, 'g1', 'f3')
    // Engine still thinking: only your move comes back.
    state = playReducer(state, { type: 'takeBack' })
    expect(playSans(state)).toEqual(['e4', 'e5'])
    expect(state.status).toBe(PLAY_STATUS.USER_TURN)
    // Engine has replied: both come back.
    state = playReducer(state, { type: 'takeBack' })
    expect(playSans(state)).toEqual([])
    expect(playReducer(state, { type: 'takeBack' })).toBe(state)
  })

  it('as Black, taking back never removes the engine first move', () => {
    let state = createPlaySession({ fen: START, userColor: 'black' })
    state = engine(state, 'e2', 'e4')
    expect(playReducer(state, { type: 'takeBack' })).toBe(state)
    state = engine(user(state, 'e7', 'e5'), 'g1', 'f3')
    state = playReducer(state, { type: 'takeBack' })
    expect(playSans(state)).toEqual(['e4'])
    expect(state.status).toBe(PLAY_STATUS.USER_TURN)
  })

  it('ends on checkmate and reports who won', () => {
    let state = createPlaySession({ fen: START, userColor: 'black' })
    state = engine(state, 'f2', 'f3')
    state = user(state, 'e7', 'e5')
    state = engine(state, 'g2', 'g4')
    state = user(state, 'd8', 'h4')
    expect(state.status).toBe(PLAY_STATUS.OVER)
    expect(state.result).toEqual({ winner: 'black', reason: 'checkmate' })
    expect(resultText(state)).toBe('You won by checkmate')
    // Nothing more can be played into a finished game.
    expect(user(state, 'a2', 'a3')).toBe(state)
  })

  it('recognises stalemate and bare kings as draws', () => {
    expect(gameResult('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', [])).toEqual({ winner: null, reason: 'stalemate' })
    expect(gameResult('8/8/8/4k3/8/4K3/8/8 w - - 0 1', [])).toEqual({ winner: null, reason: 'insufficient material' })
    expect(gameResult(START, ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']))
      .toEqual({ winner: null, reason: 'threefold repetition' })
    expect(gameResult(START, ['e4'])).toBeNull()
  })

  it('attaches a verdict to the move it judges, even after the reply has landed', () => {
    let state = createPlaySession({ fen: LUCENA, userColor: 'white' })
    state = user(state, 'f1', 'h1')
    state = engine(state, 'h3', 'h1', 'tablebase')
    expect(latestVerdict(state)).toBeNull()
    const verdict = verdictForMove(LUCENA_TABLE, 'f1h1')
    state = playReducer(state, { type: 'verdict', fenBefore: LUCENA, uci: 'f1h1', verdict })
    expect(latestVerdict(state)).toMatchObject({ kind: 'win-to-draw', ply: 0 })
    // A verdict for a move that is no longer in the game is dropped.
    const taken = playReducer(state, { type: 'takeBack' })
    expect(playReducer(taken, { type: 'verdict', fenBefore: LUCENA, uci: 'f1h1', verdict })).toBe(taken)
  })

  it('holds an engine error until retried, and restart clears everything', () => {
    let state = createPlaySession({ fen: START, userColor: 'white' })
    state = user(state, 'e2', 'e4')
    state = playReducer(state, { type: 'engineError', fenBefore: playFen(state), message: 'offline' })
    expect(state.error).toBe('offline')
    expect(playReducer(state, { type: 'retry' }).error).toBeNull()
    const fresh = playReducer(state, { type: 'restart' })
    expect(fresh.moves).toEqual([])
    expect(fresh.error).toBeNull()
    expect(fresh.status).toBe(PLAY_STATUS.USER_TURN)
    expect(playReducer(fresh, { type: 'stop' })).toBeNull()
  })

  it('accepts a pasted position and fills in the missing fields', () => {
    expect(parseStartFen('6K1/4k1P1/8/8/8/7r/8/5R2')).toEqual({ fen: LUCENA })
    expect(parseStartFen('  6K1/4k1P1/8/8/8/7r/8/5R2   b ')).toEqual({ fen: '6K1/4k1P1/8/8/8/7r/8/5R2 b - - 0 1' })
    expect(parseStartFen(LUCENA.replace(' 0 1', ' 12 40'))).toEqual({ fen: LUCENA.replace(' 0 1', ' 12 40') })
    expect(parseStartFen('')).toEqual({ error: '' })
  })

  it('rejects positions no game can reach, and finished ones', () => {
    expect(parseStartFen('hello').error).toMatch(/Not a valid position/)
    expect(parseStartFen('8/8/8/8/8/8/8/8 w - - 0 1').error).toMatch(/Not a valid position/)
    // Black is in check from the rook, yet it is White to move.
    expect(parseStartFen('4k3/8/8/8/8/8/4R3/4K3 w - - 0 1').error).toMatch(/Black's king is in check/)
    expect(parseStartFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').error).toMatch(/already over/)
    expect(parseStartFen('a b c d e f g').error).toMatch(/too many parts/)
  })

  it('numbers moves from the start position', () => {
    expect(startPlyOf(START)).toBe(0)
    expect(startPlyOf('8/8/8/8/8/8/8/K6k b - - 0 41')).toBe(81)
    expect(startPlyOf('8/8/8/8/8/8/8/K6k w - - 0 41')).toBe(80)
  })
})
