import { describe, expect, it } from 'vitest'
import {
  TRAINER_STATUS,
  buildDrillTree,
  collectLeafKeys,
  createTrainerSession,
  nodeAtPath,
  pickOpponentChild,
  trainerCurrentChildren,
  trainerExpectedChild,
  trainerProgress,
  trainerReducer,
} from './openingTrainer'

// Two Black lines that share the trunk 1.e4 c6 2.d4 d5 and diverge on White's
// 3rd move (Nc3 vs e5) — a real opponent branch point.
const caroMain = { id: 1, color: 'black', name: 'Caro main', moves_san: 'e4 c6 d4 d5 Nc3 dxe4' }
const caroAdvance = { id: 2, color: 'black', name: 'Caro advance', moves_san: 'e4 c6 d4 d5 e5 Bf5' }
const italian = { id: 3, color: 'white', name: 'Italian', moves_san: 'e4 e5 Nf3' }

function autoplay(state, rng = () => 0) {
  const node = nodeAtPath(state.tree, state.currentPath)
  const pick = pickOpponentChild(node, state.remaining, rng)
  return trainerReducer(state, { type: 'opponentMove', childPath: pick.path, san: pick.san })
}

function userPlays(state, san) {
  const child = trainerCurrentChildren(state).find(c => c.san === san)
  return trainerReducer(state, { type: 'userMove', childPath: child.path, san })
}

describe('buildDrillTree', () => {
  it('shares the common trunk and branches at the divergence', () => {
    const tree = buildDrillTree([caroMain, caroAdvance])
    expect(tree.children.map(c => c.san)).toEqual(['e4'])
    const afterD5 = nodeAtPath(tree, ['e4', 'c6', 'd4', 'd5'])
    expect(afterD5.children.map(c => c.san).sort()).toEqual(['Nc3', 'e5'])
  })

  it('collects one leaf key per maximal line', () => {
    const leaves = collectLeafKeys(buildDrillTree([caroMain, caroAdvance]))
    expect(leaves.sort()).toEqual(['e4 c6 d4 d5 Nc3 dxe4', 'e4 c6 d4 d5 e5 Bf5'])
  })
})

describe('turn detection', () => {
  it('a White repertoire waits for the user to move first', () => {
    const s = createTrainerSession({ branches: [italian], userColor: 'white' })
    expect(s.status).toBe(TRAINER_STATUS.AWAITING_USER_MOVE)
  })

  it('a Black repertoire autoplays White first', () => {
    const s = createTrainerSession({ branches: [caroMain], userColor: 'black' })
    expect(s.status).toBe(TRAINER_STATUS.AUTOPLAYING_OPPONENT)
  })
})

describe('pickOpponentChild', () => {
  const tree = buildDrillTree([caroMain, caroAdvance])
  const branchNode = nodeAtPath(tree, ['e4', 'c6', 'd4', 'd5'])

  it('is random within children when all lines remain', () => {
    const all = new Set(collectLeafKeys(tree))
    expect(pickOpponentChild(branchNode, all, () => 0).san).toBe(branchNode.children[0].san)
    expect(pickOpponentChild(branchNode, all, () => 0.99).san).toBe(branchNode.children[1].san)
  })

  it('prefers a child whose subtree still has an uncovered line', () => {
    const onlyAdvance = new Set(['e4 c6 d4 d5 e5 Bf5'])
    // rng favours the first child (Nc3), but that line is already covered:
    expect(pickOpponentChild(branchNode, onlyAdvance, () => 0).san).toBe('e5')
  })
})

describe('a full Black run with random branching', () => {
  it('walks the trunk, accepts any saved reply, and finishes a line', () => {
    let s = createTrainerSession({
      branches: [caroMain, caroAdvance], userColor: 'black', scope: { label: 'Caro-Kann' },
    })
    expect(trainerProgress(s)).toEqual({ done: 0, total: 2 })

    s = autoplay(s) // White e4 (only child)
    expect(s.currentPath).toEqual(['e4'])
    expect(s.status).toBe(TRAINER_STATUS.AWAITING_USER_MOVE)

    s = userPlays(s, 'c6')
    s = autoplay(s) // White d4
    expect(s.currentPath).toEqual(['e4', 'c6', 'd4'])

    s = userPlays(s, 'd5')
    s = autoplay(s, () => 0.99) // branch point → e5 (Advance)
    expect(s.lastSan).toBe('e5')
    expect(s.status).toBe(TRAINER_STATUS.AWAITING_USER_MOVE)

    s = userPlays(s, 'Bf5') // reaches a leaf
    expect(s.status).toBe(TRAINER_STATUS.LINE_COMPLETE)
    expect(trainerProgress(s)).toEqual({ done: 1, total: 2 })
    expect(s.cleanLines).toBe(1)
    expect(s.remaining.has('e4 c6 d4 d5 e5 Bf5')).toBe(false)

    s = trainerReducer(s, { type: 'continue' }) // one line left
    expect(s.currentPath).toEqual([])
    expect(s.status).toBe(TRAINER_STATUS.AUTOPLAYING_OPPONENT)
  })

  it('continues into the uncovered branch and finishes the whole run', () => {
    let s = createTrainerSession({
      branches: [caroMain, caroAdvance], userColor: 'black', scope: { label: 'Caro-Kann' },
    })

    s = autoplay(s) // e4
    s = userPlays(s, 'c6')
    s = autoplay(s) // d4
    s = userPlays(s, 'd5')
    s = autoplay(s, () => 0.99) // branch point -> e5 (Advance)
    s = userPlays(s, 'Bf5')
    expect(s.status).toBe(TRAINER_STATUS.LINE_COMPLETE)
    expect(trainerProgress(s)).toEqual({ done: 1, total: 2 })
    expect(s.remaining.has('e4 c6 d4 d5 Nc3 dxe4')).toBe(true)

    s = trainerReducer(s, { type: 'continue' })
    s = autoplay(s) // e4
    s = userPlays(s, 'c6')
    s = autoplay(s) // d4
    s = userPlays(s, 'd5')
    s = autoplay(s, () => 0.99) // coverage bias still picks Nc3
    expect(s.lastSan).toBe('Nc3')
    s = userPlays(s, 'dxe4')

    expect(s.status).toBe(TRAINER_STATUS.LINE_COMPLETE)
    expect(trainerProgress(s)).toEqual({ done: 2, total: 2 })
    expect(s.cleanLines).toBe(2)
    expect(s.remaining.size).toBe(0)

    s = trainerReducer(s, { type: 'continue' }) // Finish
    expect(s.status).toBe(TRAINER_STATUS.RUN_COMPLETE)
  })
})

describe('wrong move handling', () => {
  it('rejects an unsaved reply and hints after the second miss', () => {
    let s = createTrainerSession({ branches: [italian], userColor: 'white' })
    s = trainerReducer(s, { type: 'userWrong', playedSan: 'd4', expectedSan: 'e4' })
    expect(s.status).toBe(TRAINER_STATUS.WRONG_MOVE_FEEDBACK)
    expect(s.hint).toBe(false)

    s = trainerReducer(s, { type: 'userWrong', playedSan: 'c4', expectedSan: 'e4' })
    expect(s.hint).toBe(true)
    expect(trainerExpectedChild(s).san).toBe('e4')

    s = userPlays(s, 'e4') // recovering with the saved move advances
    expect(s.currentPath).toEqual(['e4'])
    expect(s.lineMisses.length).toBe(2)
  })
})

describe('run completion', () => {
  it('reports RUN_COMPLETE once every line is covered', () => {
    let s = createTrainerSession({ branches: [italian], userColor: 'white' })
    s = userPlays(s, 'e4')
    s = autoplay(s) // e5
    s = userPlays(s, 'Nf3') // leaf
    expect(s.status).toBe(TRAINER_STATUS.LINE_COMPLETE)
    expect(s.remaining.size).toBe(0)

    s = trainerReducer(s, { type: 'continue' })
    expect(s.status).toBe(TRAINER_STATUS.RUN_COMPLETE)
  })

  it('returns RUN_COMPLETE for an empty scope', () => {
    const s = createTrainerSession({ branches: [], userColor: 'white' })
    expect(s.status).toBe(TRAINER_STATUS.RUN_COMPLETE)
  })
})
