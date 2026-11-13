import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useDrillPersistence } from './useDrillPersistence'

vi.mock('../api', () => ({ api: { post: vi.fn() } }))

describe('useDrillPersistence', () => {
  beforeEach(() => vi.clearAllMocks())

  it('retries with the same event key and clears the blocking error', async () => {
    api.post.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: {} })
    const saved = vi.fn()
    const { result } = renderHook(() => useDrillPersistence(saved))

    await act(async () => {
      await result.current.send({
        event_key: 'stable-event', source: 'practice', solved: false, node_id: 1,
      })
    })
    expect(result.current.error).toMatch(/Retry/)

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.error).toBe('')
    expect(api.post).toHaveBeenCalledTimes(2)
    expect(api.post.mock.calls[0][1].event_key).toBe('stable-event')
    expect(api.post.mock.calls[1][1].event_key).toBe('stable-event')
    expect(saved).toHaveBeenCalledTimes(1)
  })

  it('keeps an un-retried failure retryable when a new send arrives', async () => {
    // First attempt fails; a second send must be refused (return false) rather than
    // overwriting the retry target, so retry still replays the original failure.
    api.post
      .mockRejectedValueOnce(new Error('offline'))   // first send
      .mockResolvedValueOnce({ data: {} })           // retry of the first
    const { result } = renderHook(() => useDrillPersistence())

    await act(async () => {
      await result.current.send({ event_key: 'first', source: 'practice', solved: false, node_id: 1 })
    })
    expect(result.current.error).toMatch(/Retry/)

    let accepted
    await act(async () => {
      accepted = await result.current.send({ event_key: 'second', source: 'practice', solved: false, node_id: 2 })
    })
    expect(accepted).toBe(false)
    expect(api.post).toHaveBeenCalledTimes(1)   // second send never hit the network

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.error).toBe('')
    expect(api.post).toHaveBeenCalledTimes(2)
    expect(api.post.mock.calls[1][1].event_key).toBe('first')   // original failure replayed
  })

  it('ignores a late success from a cleared session without affecting the new attempt', async () => {
    let resolveOld
    let resolveNew
    const oldRequest = new Promise(resolve => { resolveOld = resolve })
    const newRequest = new Promise(resolve => { resolveNew = resolve })
    api.post.mockReturnValueOnce(oldRequest).mockReturnValueOnce(newRequest)

    const onSaved = vi.fn()
    const oldSuccess = vi.fn()
    const newSuccess = vi.fn()
    const { result } = renderHook(() => useDrillPersistence(onSaved))

    let oldSend
    let newSend
    act(() => {
      oldSend = result.current.send({ event_key: 'old-attempt', source: 'practice' }, oldSuccess)
      result.current.clear()
      newSend = result.current.send({ event_key: 'new-attempt', source: 'practice' }, newSuccess)
    })

    await act(async () => {
      resolveOld({ data: { old: true } })
      await oldSend
    })
    expect(result.current.pending).toBe(true)
    expect(oldSuccess).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()

    await act(async () => {
      resolveNew({ data: { new: true } })
      await newSend
    })
    expect(result.current.pending).toBe(false)
    expect(result.current.error).toBe('')
    expect(newSuccess).toHaveBeenCalledTimes(1)
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('ignores a late failure from a cleared session', async () => {
    let rejectOld
    const oldRequest = new Promise((_, reject) => { rejectOld = reject })
    api.post.mockReturnValueOnce(oldRequest)

    const { result } = renderHook(() => useDrillPersistence())
    let oldSend
    act(() => {
      oldSend = result.current.send({ event_key: 'abandoned', source: 'practice' })
      result.current.clear()
    })
    await act(async () => {
      rejectOld(new Error('network'))
      await oldSend
    })
    expect(result.current.error).toBe('')
    expect(result.current.pending).toBe(false)
    expect(api.post).toHaveBeenCalledTimes(1)
  })
})
