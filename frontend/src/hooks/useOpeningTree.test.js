import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useOpeningTree } from './useOpeningTree'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    get: vi.fn(),
  },
}))

describe('useOpeningTree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ignores stale responses when color/path changes quickly', async () => {
    let resolveFirst
    const firstPromise = new Promise((resolve) => { resolveFirst = resolve })
    api.get.mockImplementationOnce(() => firstPromise)
    api.get.mockResolvedValueOnce({ data: { moves: [{ san: 'Nf3' }] } })

    const { result, rerender } = renderHook(
      ({ color, pathKey }) => useOpeningTree({ color, pathKey, timeClass: '' }),
      { initialProps: { color: 'white', pathKey: 'e4 e5' } },
    )

    rerender({ color: 'white', pathKey: 'e4 e5 Nf3' })

    resolveFirst({ data: { moves: [{ san: 'd4' }] } })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.tree?.moves?.[0]?.san).toBe('Nf3')
  })

  it('surfaces API errors without crashing', async () => {
    api.get.mockRejectedValueOnce(new Error('network'))

    const { result } = renderHook(() =>
      useOpeningTree({ color: 'white', pathKey: '', timeClass: '' }),
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBe(true)
    expect(result.current.tree).toBeNull()
  })
})

describe('useRepertoire', () => {
  it('reload fetches fresh data', async () => {
    const { useRepertoire } = await import('./useRepertoire')
    api.get.mockResolvedValueOnce({ data: { branches: [], due: [] } })

    const { result } = renderHook(() => useRepertoire('white'))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    api.get.mockResolvedValueOnce({ data: { branches: [{ id: 1 }], due: [] } })

    await act(async () => {
      await result.current.reload()
    })

    expect(result.current.repertoire?.branches).toHaveLength(1)
  })
})
