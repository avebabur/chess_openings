import { describe, expect, it } from 'vitest'
import {
  REVIEW_STATUS,
  createReviewSession,
  currentReviewItem,
  reviewCompletedCount,
  reviewDisplayPath,
  reviewPriorPath,
  reviewReducer,
} from './reviewSession'

const dueNodes = [
  {
    id: 21,
    color: 'white',
    path_san: 'e4 e5 Nf3',
    san: 'Nf3',
    fen_after: 'fen-after-nf3',
  },
  {
    id: 22,
    color: 'white',
    path_san: 'e4 e5 Nf3 Nc6 Bc4',
    san: 'Bc4',
    fen_after: 'fen-after-bc4',
  },
]

describe('reviewSession reducer', () => {
  it('starts from the prior position of the due node', () => {
    const state = createReviewSession(dueNodes)

    expect(state.status).toBe(REVIEW_STATUS.ASKING)
    expect(currentReviewItem(state).san).toBe('Nf3')
    expect(reviewPriorPath(state)).toEqual(['e4', 'e5'])
    expect(reviewDisplayPath(state)).toEqual(['e4', 'e5'])
  })

  it('reveals the correct path after a correct answer', () => {
    const state = reviewReducer(createReviewSession(dueNodes), {
      type: 'userMoveResult',
      correct: true,
      playedSan: 'Nf3',
    })

    expect(state.status).toBe(REVIEW_STATUS.REVEALED)
    expect(state.wrong).toBe(false)
    expect(state.playedSan).toBe('Nf3')
    expect(state.solved).toBe(1)
    expect(reviewDisplayPath(state)).toEqual(['e4', 'e5', 'Nf3'])
  })

  it('stores the wrong move separately from the expected move', () => {
    const state = reviewReducer(createReviewSession(dueNodes), {
      type: 'userMoveResult',
      correct: false,
      playedSan: 'Bc4',
    })

    expect(state.status).toBe(REVIEW_STATUS.REVEALED)
    expect(state.wrong).toBe(true)
    expect(state.playedSan).toBe('Bc4')
    expect(currentReviewItem(state).san).toBe('Nf3')
    expect(state.missed).toBe(1)
  })

  it('advances and completes predictably', () => {
    let state = reviewReducer(createReviewSession(dueNodes), {
      type: 'userMoveResult',
      correct: true,
      playedSan: 'Nf3',
    })
    expect(reviewCompletedCount(state)).toBe(1)

    state = reviewReducer(state, { type: 'next' })
    expect(state.status).toBe(REVIEW_STATUS.ASKING)
    expect(currentReviewItem(state).san).toBe('Bc4')

    state = reviewReducer(state, {
      type: 'userMoveResult',
      correct: false,
      playedSan: 'd4',
    })
    state = reviewReducer(state, { type: 'next' })

    expect(state.status).toBe(REVIEW_STATUS.COMPLETE)
    expect(currentReviewItem(state)).toBeNull()
  })

  it('does not start for an empty queue', () => {
    expect(createReviewSession([])).toBeNull()
  })
})
