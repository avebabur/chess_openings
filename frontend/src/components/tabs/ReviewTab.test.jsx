import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REVIEW_STATUS } from '../../domain/reviewSession'
import ReviewTab from './ReviewTab'

afterEach(cleanup)

const item = {
  id: 1,
  color: 'white',
  san: 'e4',
  path: ['e4'],
  priorPath: [],
}

function props(overrides = {}) {
  return {
    review: {
      queue: [item], idx: 0, status: REVIEW_STATUS.REVEALED,
      solved: 1, missed: 0, wrong: false, playedSan: 'e4',
    },
    reviewItem: item,
    reviewPriorPath: [],
    dueNodes: [],
    duePreview: [],
    branches: [],
    trainedBranches: [],
    reviewWrite: { pending: false, error: '', attempt: null },
    onFinishReview: vi.fn(),
    onNextReview: vi.fn(),
    onCompleteReview: vi.fn(),
    onRetryReviewWrite: vi.fn(),
    ...overrides,
  }
}

describe('ReviewTab completion persistence', () => {
  it('enters the completion state instead of clearing the last result', () => {
    const input = props()
    const { getByRole } = render(<ReviewTab {...input} />)

    fireEvent.click(getByRole('button', { name: 'Finish' }))

    expect(input.onCompleteReview).toHaveBeenCalledOnce()
    expect(input.onFinishReview).not.toHaveBeenCalled()
  })

  it('blocks advancement on a write error and offers retry', () => {
    const input = props({
      reviewWrite: { pending: false, error: 'Could not save this review result.', attempt: {} },
    })
    const { getByRole } = render(<ReviewTab {...input} />)

    expect(getByRole('button', { name: 'Finish' }).disabled).toBe(true)
    fireEvent.click(getByRole('button', { name: 'Retry' }))
    expect(input.onRetryReviewWrite).toHaveBeenCalledOnce()
  })
})
