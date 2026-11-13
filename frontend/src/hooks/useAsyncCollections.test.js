import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useRepertoire } from './useRepertoire'
import { useOpenings } from './useOpenings'

vi.mock('../api', () => ({ api: { get: vi.fn() } }))

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

describe('repertoire and opening loads', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('does not allow an older manual repertoire reload to overwrite newer data', async () => {
    api.get.mockResolvedValueOnce({ data: { marker: 'initial' } })
    const { result } = renderHook(() => useRepertoire('white'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const old = deferred()
    api.get.mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ data: { marker: 'latest' } })

    let olderReload
    act(() => { olderReload = result.current.reload() })
    await act(async () => { await result.current.reload() })
    expect(result.current.repertoire?.marker).toBe('latest')

    await act(async () => {
      old.resolve({ data: { marker: 'stale' } })
      await olderReload
    })
    expect(result.current.repertoire?.marker).toBe('latest')
  })

  it('discards repertoire responses for the previous color', async () => {
    const previousColor = deferred()
    api.get.mockReturnValueOnce(previousColor.promise)
      .mockResolvedValueOnce({ data: { marker: 'black' } })

    const { result, rerender } = renderHook(
      ({ color }) => useRepertoire(color),
      { initialProps: { color: 'white' } },
    )
    rerender({ color: 'black' })
    await waitFor(() => expect(result.current.repertoire?.marker).toBe('black'))

    await act(async () => {
      previousColor.resolve({ data: { marker: 'white' } })
      await previousColor.promise
    })
    expect(result.current.repertoire?.marker).toBe('black')
  })

  it('discards outdated opening lists when switching colors', async () => {
    const previousColor = deferred()
    api.get.mockReturnValueOnce(previousColor.promise)
      .mockResolvedValueOnce({ data: [{ name: 'Black opening' }] })

    const { result, rerender } = renderHook(
      ({ color }) => useOpenings(color),
      { initialProps: { color: 'white' } },
    )
    rerender({ color: 'black' })
    await waitFor(() => expect(result.current.openings).toEqual([{ name: 'Black opening' }]))

    await act(async () => {
      previousColor.resolve({ data: [{ name: 'White opening' }] })
      await previousColor.promise
    })
    expect(result.current.openings).toEqual([{ name: 'Black opening' }])
  })

  it('does not allow an outdated opening reload to clear a newer error or result', async () => {
    api.get.mockResolvedValueOnce({ data: [{ name: 'Initial' }] })
    const { result } = renderHook(() => useOpenings('white'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const old = deferred()
    api.get.mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ data: [{ name: 'New' }] })
    let olderReload
    act(() => { olderReload = result.current.reload() })
    await act(async () => { await result.current.reload() })

    await act(async () => {
      old.resolve({ data: [{ name: 'Old' }] })
      await olderReload
    })
    expect(result.current.openings).toEqual([{ name: 'New' }])
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBe(false)
  })
})
