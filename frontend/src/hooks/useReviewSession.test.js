import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useReviewSession } from './useReviewSession'

vi.mock('../api', () => ({ api: { post: vi.fn() } }))

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const firstItem = { id: 1, san: 'e4', path: ['e4'] }
const secondItem = { id: 2, san: 'd4', path: ['d4'] }

describe('useReviewSession write lifecycle', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('ignores a completed write after the session resets', async () => {
    const previous = deferred()
    const current = deferred()
    api.post.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
    const reloadRepertoire = vi.fn().mockResolvedValue({})
    const { result } = renderHook(() => useReviewSession(reloadRepertoire))

    let oldWrite
    let newWrite
    act(() => {
      oldWrite = result.current.recordReview(firstItem, true, 'e4', 'previous-key')
      result.current.resetReviewWrite()
      newWrite = result.current.recordReview(secondItem, false, 'Nf3', 'current-key')
    })

    await act(async () => {
      previous.resolve({ data: {} })
      await oldWrite
    })
    expect(result.current.reviewWrite.pending).toBe(true)
    expect(reloadRepertoire).not.toHaveBeenCalled()

    await act(async () => {
      current.resolve({ data: {} })
      await newWrite
    })
    expect(result.current.reviewWrite).toEqual({ pending: false, error: '', attempt: null })
    expect(reloadRepertoire).toHaveBeenCalledTimes(1)
    expect(api.post.mock.calls[1][1].event_key).toBe('current-key')
  })

  it('does not resurrect a failed write after a reset', async () => {
    const previous = deferred()
    api.post.mockReturnValueOnce(previous.promise)
    const { result } = renderHook(() => useReviewSession(vi.fn()))

    let pending
    act(() => {
      pending = result.current.recordReview(firstItem, false, 'd4', 'outdated-key')
      result.current.resetReviewWrite()
    })

    await act(async () => {
      previous.reject(new Error('offline'))
      await pending
    })
    expect(result.current.reviewWrite).toEqual({ pending: false, error: '', attempt: null })
  })

  it('accepts only one write while the current request is pending', async () => {
    const request = deferred()
    api.post.mockReturnValueOnce(request.promise)
    const { result } = renderHook(() => useReviewSession(vi.fn().mockResolvedValue({})))

    let pending
    let duplicate
    act(() => {
      pending = result.current.recordReview(firstItem, true, 'e4', 'first-key')
      duplicate = result.current.recordReview(secondItem, true, 'd4', 'second-key')
    })
    expect(await duplicate).toBe(false)
    expect(api.post).toHaveBeenCalledTimes(1)

    await act(async () => {
      request.resolve({ data: {} })
      await pending
    })
    expect(result.current.reviewWrite.pending).toBe(false)
  })
})
