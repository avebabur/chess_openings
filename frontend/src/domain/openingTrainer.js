import { splitSanLine } from './chessLine'

// Tree-walking opening trainer. Unlike the single-line practice session, this
// walks a *tree* built from many saved branches: on the opponent's turn a random
// saved reply is played (biased toward lines you still have left to cover this
// run), and on your turn any saved reply is accepted. Reaching a leaf finishes a
// "line"; "Continue" starts a fresh walk until every line in scope is covered.
export const TRAINER_STATUS = {
  AUTOPLAYING_OPPONENT: 'autoplayingOpponent',
  AWAITING_USER_MOVE: 'awaitingUserMove',
  WRONG_MOVE_FEEDBACK: 'wrongMoveFeedback',
  LINE_COMPLETE: 'lineComplete',
  RUN_COMPLETE: 'runComplete',
}

// --- Drill tree (a SAN trie over the in-scope branches) ---

export function buildDrillTree(branches) {
  const root = { san: null, path: [], children: [] }
  for (const branch of branches || []) {
    const sans = splitSanLine(branch?.moves_san)
    if (!sans.length) continue
    let node = root
    const acc = []
    for (const san of sans) {
      acc.push(san)
      let child = node.children.find(c => c.san === san)
      if (!child) {
        child = { san, path: acc.slice(), children: [] }
        node.children.push(child)
      }
      node = child
    }
  }
  return root
}

export function collectLeafKeys(node, out = []) {
  if (!node) return out
  if (!node.children.length) {
    if (node.path.length) out.push(node.path.join(' '))
    return out
  }
  for (const child of node.children) collectLeafKeys(child, out)
  return out
}

export function nodeAtPath(root, path) {
  let node = root
  for (const san of path || []) {
    node = (node?.children || []).find(c => c.san === san)
    if (!node) return null
  }
  return node || null
}

function subtreeHasRemaining(node, remaining) {
  if (!node.children.length) return remaining.has(node.path.join(' '))
  return node.children.some(child => subtreeHasRemaining(child, remaining))
}

// Pick the opponent's reply: prefer children whose subtree still holds an
// un-covered line so the run keeps making progress, but stay random within that
// set so the same opening unfolds differently each time.
export function pickOpponentChild(node, remaining, rng = Math.random) {
  const children = node?.children || []
  if (!children.length) return null
  const preferred = children.filter(c => subtreeHasRemaining(c, remaining))
  const pool = preferred.length ? preferred : children
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]
}

// --- Session state ---

export function trainerCurrentNode(state) {
  return state ? nodeAtPath(state.tree, state.currentPath) : null
}

export function trainerCurrentChildren(state) {
  return trainerCurrentNode(state)?.children || []
}

// The move to surface as a hint / attribute a miss to when several replies are
// saved. The trainer accepts any saved reply, but needs one canonical answer.
export function trainerExpectedChild(state) {
  return trainerCurrentChildren(state)[0] || null
}

export function trainerProgress(state) {
  if (!state) return { done: 0, total: 0 }
  return { done: state.linesDone, total: state.linesTotal }
}

function isUserTurn(userColor, currentPath) {
  const whiteToMove = currentPath.length % 2 === 0
  return whiteToMove === (userColor === 'white')
}

function settleTrainerTurn(state) {
  const node = nodeAtPath(state.tree, state.currentPath)
  const children = node?.children || []
  const base = { ...state, hint: false, lineRecorded: false }
  if (!children.length) {
    const key = state.currentPath.join(' ')
    const wasRemaining = state.remaining.has(key)
    const remaining = new Set(state.remaining)
    remaining.delete(key)
    return {
      ...base,
      status: TRAINER_STATUS.LINE_COMPLETE,
      remaining,
      linesDone: state.linesDone + (wasRemaining ? 1 : 0),
      cleanLines: state.cleanLines + (wasRemaining && state.lineMisses.length === 0 ? 1 : 0),
    }
  }
  return {
    ...base,
    status: isUserTurn(state.userColor, state.currentPath)
      ? TRAINER_STATUS.AWAITING_USER_MOVE
      : TRAINER_STATUS.AUTOPLAYING_OPPONENT,
  }
}

export function createTrainerSession({ branches, userColor, scope } = {}) {
  const tree = buildDrillTree(branches)
  const leaves = collectLeafKeys(tree)
  const base = {
    tree,
    userColor: userColor === 'black' ? 'black' : 'white',
    scope: scope || null,
    currentPath: [],
    remaining: new Set(leaves),
    linesTotal: leaves.length,
    linesDone: 0,
    cleanLines: 0,
    lineMisses: [],
    status: null,
    lastSan: null,
    lastMoveBy: null,
    feedback: null,
    hint: false,
    lineRecorded: false,
  }
  if (!leaves.length) return { ...base, status: TRAINER_STATUS.RUN_COMPLETE }
  return settleTrainerTurn(base)
}

const ACCEPTS_USER_MOVE = [TRAINER_STATUS.AWAITING_USER_MOVE, TRAINER_STATUS.WRONG_MOVE_FEEDBACK]

export function trainerReducer(state, action) {
  switch (action.type) {
    case 'start':
      return createTrainerSession(action.payload)
    case 'stop':
      return null
    case 'opponentMove': {
      if (!state || state.status !== TRAINER_STATUS.AUTOPLAYING_OPPONENT) return state
      return settleTrainerTurn({
        ...state,
        currentPath: action.childPath,
        lastSan: action.san,
        lastMoveBy: 'opponent',
        feedback: { kind: 'opponent', san: action.san },
      })
    }
    case 'userMove': {
      if (!state || !ACCEPTS_USER_MOVE.includes(state.status)) return state
      return settleTrainerTurn({
        ...state,
        currentPath: action.childPath,
        lastSan: action.san,
        lastMoveBy: 'user',
        feedback: { kind: 'correct', playedSan: action.san },
      })
    }
    case 'userWrong': {
      if (!state || !ACCEPTS_USER_MOVE.includes(state.status)) return state
      const key = state.currentPath.join(' ')
      const miss = {
        path: key,
        expectedSan: action.expectedSan || null,
        playedSan: action.playedSan || null,
      }
      const lineMisses = [...state.lineMisses, miss]
      return {
        ...state,
        status: TRAINER_STATUS.WRONG_MOVE_FEEDBACK,
        lineMisses,
        lastSan: action.playedSan || null,
        lastMoveBy: 'user',
        feedback: { kind: 'wrong', ...miss },
        hint: lineMisses.filter(m => m.path === key).length >= 2,
      }
    }
    case 'markLineRecorded':
      return state ? { ...state, lineRecorded: true } : state
    case 'continue': {
      if (!state) return state
      if (state.remaining.size === 0) {
        return { ...state, status: TRAINER_STATUS.RUN_COMPLETE }
      }
      return settleTrainerTurn({
        ...state,
        currentPath: [],
        lineMisses: [],
        lastSan: null,
        lastMoveBy: null,
        feedback: null,
      })
    }
    default:
      return state
  }
}
