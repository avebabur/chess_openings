import { reviewQueueFromDueNodes } from './chessLine'

export const REVIEW_STATUS = {
  ASKING: 'asking',
  REVEALED: 'revealed',
  COMPLETE: 'complete',
}

export function createReviewSession(dueNodes) {
  const queue = reviewQueueFromDueNodes(dueNodes)
  if (!queue.length) return null
  return {
    queue,
    idx: 0,
    status: REVIEW_STATUS.ASKING,
    solved: 0,
    missed: 0,
    wrong: false,
    playedSan: null,
  }
}

export function currentReviewItem(state) {
  if (!state || state.status === REVIEW_STATUS.COMPLETE) return null
  return state.queue[state.idx] || null
}

export function reviewPriorPath(state) {
  return currentReviewItem(state)?.priorPath || []
}

export function reviewDisplayPath(state) {
  const item = currentReviewItem(state)
  if (!item) return []
  return state.status === REVIEW_STATUS.REVEALED ? item.path : item.priorPath
}

export function reviewCompletedCount(state) {
  if (!state) return 0
  return Math.min(
    state.queue.length,
    state.idx + (state.status === REVIEW_STATUS.REVEALED ? 1 : 0),
  )
}

export function reviewReducer(state, action) {
  switch (action.type) {
    case 'start':
      return createReviewSession(action.dueNodes)
    case 'finish':
      return state ? { ...state, status: REVIEW_STATUS.COMPLETE, idx: state.queue.length } : state
    case 'clear':
      return null
    case 'next': {
      if (!state || state.status !== REVIEW_STATUS.REVEALED) return state
      const nextIdx = state.idx + 1
      if (nextIdx >= state.queue.length) {
        return { ...state, status: REVIEW_STATUS.COMPLETE, idx: nextIdx }
      }
      return {
        ...state,
        idx: nextIdx,
        status: REVIEW_STATUS.ASKING,
        wrong: false,
        playedSan: null,
      }
    }
    case 'userMoveResult': {
      if (!state || state.status !== REVIEW_STATUS.ASKING) return state
      return {
        ...state,
        status: REVIEW_STATUS.REVEALED,
        wrong: !action.correct,
        playedSan: action.playedSan || null,
        solved: state.solved + (action.correct ? 1 : 0),
        missed: state.missed + (action.correct ? 0 : 1),
      }
    }
    default:
      return state
  }
}
