import { describe, expect, it } from 'vitest'
import { makeMove } from './chessLine'
import { createPlaySession, goalEnded, playFen, playReducer } from './playSession'
import {
  assessmentFromReply,
  describeGoal,
  goalLabel,
  goalOutcomeText,
  judgeGoal,
  mistakeGoal,
  ratingText,
} from './practiceGoal'

const goal = (kind, cp = null, moves = null) => ({ kind, cp, moves })
const move = (extra = {}) => ({ by: 'user', uci: 'a1a2', ...extra })
const rated = (cp, outcome = null, extra = {}) => move({ assessment: { cp, outcome }, ...extra })
const judge = (g, moves, result = null, userColor = 'white') => judgeGoal({ goal: g, userColor, moves, result })

describe('assessmentFromReply', () => {
  it('turns the reply into the user side: Stockfish rates from White, the tablebase from the replier', () => {
    expect(assessmentFromReply({ cp: 250, outcome: null }, 'white')).toEqual({ cp: 250, outcome: null })
    expect(assessmentFromReply({ cp: 250, outcome: null }, 'black')).toEqual({ cp: -250, outcome: null })
    // The replier is lost, so the user won.
    expect(assessmentFromReply({ cp: null, outcome: 'loss' }, 'white')).toEqual({ cp: 10000, outcome: 'win' })
    expect(assessmentFromReply({ cp: null, outcome: 'draw' }, 'black')).toEqual({ cp: 0, outcome: 'draw' })
    expect(assessmentFromReply({}, 'white')).toEqual({ cp: null, outcome: null })
  })
})

describe('judging a goal', () => {
  it('mate: needs checkmate within the limit', () => {
    const g = goal('mate', null, 2)
    expect(judge(g, [move()]).state).toBe('running')
    expect(judge(g, [move(), move()]).reason).toBe('too-slow')
    expect(judge(g, [move()], { winner: 'white', reason: 'checkmate' })).toMatchObject({ state: 'solved', reason: 'checkmate' })
    // Mating on the last allowed move still counts.
    expect(judge(g, [move(), move()], { winner: 'white', reason: 'checkmate' }).state).toBe('solved')
    expect(judge(g, [move()], { winner: 'black', reason: 'checkmate' }).reason).toBe('checkmated')
    expect(judge(g, [move()], { winner: null, reason: 'stalemate' })).toMatchObject({ state: 'failed', reason: 'drawn' })
    expect(judge(goal('mate'), Array(40).fill(move())).state).toBe('running')
  })

  it('eval: one of the first moves must reach the rating', () => {
    const g = goal('eval', 300, 2)
    expect(judge(g, [move()]).state).toBe('running') // not rated yet
    expect(judge(g, [rated(120)]).state).toBe('running')
    expect(judge(g, [rated(120), rated(310)])).toMatchObject({ state: 'solved', cp: 310 })
    expect(judge(g, [rated(120), rated(180)])).toMatchObject({ state: 'failed', reason: 'short', cp: 180 })
    expect(judge(g, [rated(350)]).state).toBe('solved')
    // A move after the limit does not count.
    expect(judge(goal('eval', 300, 1), [rated(100), rated(500)]).state).toBe('failed')
  })

  it('eval: the rating is from the user side, so a Black user needs the engine to like Black', () => {
    const asBlack = assessmentFromReply({ cp: -400 }, 'black')
    expect(judge(goal('eval', 300, 1), [move({ assessment: asBlack })], null, 'black').state).toBe('solved')
  })

  it('promotion: the promoting move must leave enough advantage', () => {
    const g = goal('promotion', 100)
    expect(judge(g, [rated(200, 'win')]).state).toBe('running')
    expect(judge(g, [rated(10000, 'win', { uci: 'e7e8q' })])).toMatchObject({ state: 'solved', reason: 'promoted' })
    expect(judge(g, [rated(20, null, { uci: 'e7e8q' })])).toMatchObject({ state: 'failed', reason: 'promoted-weak' })
    // The tablebase can see the win go before the pawn promotes.
    expect(judge(g, [rated(0, 'draw')])).toMatchObject({ state: 'failed', reason: 'lost-win' })
    // Waiting for the rating of the last move is not a failure.
    expect(judge(g, [rated(10000, 'win'), move()]).state).toBe('running')
  })

  it('win: promotion judged against a winning rating', () => {
    expect(judge(goal('win'), [rated(250, null, { uci: 'd7d8q' })]).state).toBe('failed')
    expect(judge(goal('win'), [rated(900, null, { uci: 'd7d8q' })]).state).toBe('solved')
  })

  it('equalize: reach a level position in time, or draw', () => {
    const g = goal('equalize', null, 2)
    expect(judge(g, [rated(-300)]).state).toBe('running')
    expect(judge(g, [rated(-300), rated(-40)])).toMatchObject({ state: 'solved', reason: 'level' })
    expect(judge(g, [rated(-300), rated(-200)])).toMatchObject({ state: 'failed', reason: 'still-worse' })
    expect(judge(g, [rated(-300)], { winner: null, reason: 'stalemate' }).state).toBe('solved')
  })

  it('draw: survive the moves without losing', () => {
    const g = goal('draw', null, 3)
    expect(judge(g, [rated(0, 'draw'), rated(0, 'draw')]).state).toBe('running')
    expect(judge(g, [rated(0, 'draw'), rated(0, 'draw'), rated(0, 'draw')])).toMatchObject({ state: 'solved', reason: 'held' })
    expect(judge(g, [rated(0, 'draw'), rated(-10000, 'loss')])).toMatchObject({ state: 'failed', reason: 'lost' })
    expect(judge(g, [move()]).state).toBe('running')
  })

  it('a lesson has nothing to judge', () => {
    expect(judge(goal('study'), [rated(500)])).toBeNull()
    expect(judge(null, [])).toBeNull()
  })
})

describe('describing goals', () => {
  it('says what to do in plain words', () => {
    expect(describeGoal(goal('mate', null, 1)).title).toBe('Checkmate in one move')
    expect(describeGoal(goal('mate', null, 3)).detail).toContain('3rd move')
    expect(describeGoal(goal('eval', 300, 2)).title).toBe('Be 3 pawns better within 2 moves')
    expect(describeGoal(goal('eval', 50, 1)).title).toBe('Be 0.5 pawns better within one move')
    expect(describeGoal(goal('draw', null, 20)).title).toBe('Hold the draw for 20 moves')
    expect(goalLabel(goal('promotion', 100))).toBe('Promote, +1')
    expect(goalLabel(goal('mate'))).toBe('Checkmate')
  })

  it('words the result', () => {
    const missed = judge(goal('eval', 300, 2), [rated(120), rated(180)])
    expect(goalOutcomeText(goal('eval', 300, 2), missed).body).toContain('+1.8')
    expect(goalOutcomeText(goal('eval', 300, 2), missed).body).toContain('+3')
    expect(goalOutcomeText(goal('mate', null, 2), { state: 'running' })).toBeNull()
  })
})

describe('a practice game in the play session', () => {
  const FEN = '6k1/4Rppp/8/8/8/8/5PPP/6K1 w - - 0 1' // back-rank mate in one

  it('ends on checkmate and counts as solved', () => {
    let state = createPlaySession({ fen: FEN, userColor: 'white', goal: goal('mate', null, 1), practice: { id: 7 } })
    expect(goalEnded(state)).toBe(false)
    state = playReducer(state, { type: 'userMove', move: makeMove(playFen(state), 'e7', 'e8') })
    expect(state.goalState).toMatchObject({ state: 'solved', reason: 'checkmate' })
    expect(state.status).toBe('over')
  })

  it('ends at once when the move limit is used up without mate', () => {
    let state = createPlaySession({ fen: FEN, userColor: 'white', goal: goal('mate', null, 1) })
    state = playReducer(state, { type: 'userMove', move: makeMove(playFen(state), 'g1', 'h1') })
    expect(state.goalState).toMatchObject({ state: 'failed', reason: 'too-slow' })
    expect(state.status).toBe('over')
    // A finished goal cannot be undone, only retried.
    expect(playReducer(state, { type: 'takeBack' })).toBe(state)
    const again = playReducer(state, { type: 'restart' })
    expect(again.status).toBe('userTurn')
    expect(again.attempt).toBe(2)
  })

  it('waits for the engine reply to rate the move, then ends the game on it', () => {
    const start = '4k3/8/8/8/8/1q6/8/R3K3 w - - 0 1'
    let state = createPlaySession({ fen: start, userColor: 'white', goal: goal('eval', 300, 1) })
    state = playReducer(state, { type: 'userMove', move: makeMove(playFen(state), 'a1', 'a8') })
    expect(state.status).toBe('engineThinking')
    expect(state.goalState.state).toBe('running')
    const after = playFen(state)
    state = playReducer(state, { type: 'assessment', fen: after, reply: { cp: 450, outcome: null } })
    expect(state.goalState).toMatchObject({ state: 'solved', reason: 'rating' })
    expect(state.status).toBe('over')
  })

  it('ignores a rating that belongs to a position already left', () => {
    let state = createPlaySession({ fen: FEN, userColor: 'white', goal: goal('eval', 100, 3) })
    state = playReducer(state, { type: 'userMove', move: makeMove(playFen(state), 'g1', 'h1') })
    const same = playReducer(state, { type: 'assessment', fen: 'some other fen', reply: { cp: 900 } })
    expect(same).toBe(state)
  })

  it('a lesson plays on with no goal state', () => {
    const state = createPlaySession({ fen: FEN, userColor: 'white', goal: goal('study') })
    expect(state.goalState).toBeNull()
    expect(state.status).toBe('userTurn')
  })
})

describe('a mistake from your own game', () => {
  const mistake = {
    target_cp: 50, played_san: 'Qh5', played_uci: 'd1h5', best_san: 'Nf3',
    cp_before: 110, cp_after: -240, source: 'stockfish',
  }
  const g = mistakeGoal(mistake)
  const first = (uci, san, cp) => [{ by: 'user', uci, san, assessment: cp == null ? null : { cp, outcome: null } }]
  const run = (moves, result = null) => judgeGoal({ goal: g, userColor: 'white', moves, result })

  it('describes what happened in the game', () => {
    expect(describeGoal(g).title).toBe('Find a better move than Qh5')
    expect(describeGoal(g).detail).toContain('from +1.1 to -2.4')
    expect(ratingText(10000, 'tablebase')).toBe('winning')
    expect(ratingText(0, 'tablebase')).toBe('a draw')
  })

  it('waits for the rating, then judges the one move', () => {
    expect(run([]).state).toBe('running')
    expect(run(first('g1f3', 'Nf3', null)).state).toBe('running')
    const good = run(first('g1f3', 'Nf3', 90))
    expect(good).toMatchObject({ state: 'solved', reason: 'better', san: 'Nf3' })
    expect(goalOutcomeText(g, good).body).toContain('first choice too')
    const bad = run(first('a2a3', 'a3', -100))
    expect(bad).toMatchObject({ state: 'failed', reason: 'not-better' })
    expect(goalOutcomeText(g, bad).body).toContain('It would have played Nf3')
  })

  it('fails the move from the game without waiting', () => {
    expect(run(first('d1h5', 'Qh5', null))).toMatchObject({ state: 'failed', reason: 'same-move' })
  })

  it('accepts a draw only when a draw is all there was', () => {
    const drawn = { winner: null, reason: 'stalemate' }
    expect(run(first('a2a3', 'a3', null), drawn).state).toBe('failed')
    const holding = judgeGoal({
      goal: { ...g, cp: -100 }, userColor: 'white', moves: first('a2a3', 'a3', null), result: drawn,
    })
    expect(holding.state).toBe('solved')
  })
})
