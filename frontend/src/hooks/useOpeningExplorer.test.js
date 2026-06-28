import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useOpeningExplorer } from './useOpeningExplorer'

vi.mock('../api', () => ({
  api: { get: vi.fn() },
}))

describe('useOpeningExplorer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockResolvedValue({ data: { source: 'lichess', moves: [] } })
  })

  it('can reload the current position after token changes', async () => {
    const { result } = renderHook(() => useOpeningExplorer('test-fen'))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1), { timeout: 1000 })

    act(() => result.current.reload())

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2), { timeout: 1000 })
  })
})
