import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useRepertoire } from './useRepertoire'
import { api } from '../api'

vi.mock('../api', () => ({
  api: { get: vi.fn() },
}))

describe('useRepertoire', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('drops a reload for the previous color that lands after a color switch', async () => {
    api.get.mockResolvedValueOnce({ data: { color: 'white' } })   // initial white load
    const { result, rerender } = renderHook(({ color }) => useRepertoire(color), {
      initialProps: { color: 'white' },
    })
    await waitFor(() => expect(result.current.repertoire?.color).toBe('white'))

    // A save/drill on White triggers reload(); it is still in flight when the
    // user switches to Black, and only resolves after Black has loaded.
    let resolveStale
    api.get.mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve }))
    api.get.mockResolvedValueOnce({ data: { color: 'black' } })
    let staleReload
    act(() => { staleReload = result.current.reload() })
    rerender({ color: 'black' })
    await waitFor(() => expect(result.current.repertoire?.color).toBe('black'))

    await act(async () => {
      resolveStale({ data: { color: 'white' } })
      await staleReload
    })
    expect(result.current.repertoire?.color).toBe('black')
    expect(result.current.loading).toBe(false)
  })
})
