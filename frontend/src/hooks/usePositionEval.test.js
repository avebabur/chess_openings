import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { api } from '../api'
import {
  DEFAULT_TARGET,
  DEFAULT_TIME,
  TIME_TIERS,
  canSavePositionEval,
  nextTier,
  prevTier,
  targetIsDeeper,
  targetIsInfinite,
  usePositionEval,
} from './usePositionEval'

vi.mock('../api', () => ({
  API: '/api',
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))

describe('time tiers', () => {
  it('steps deepen through every tier', () => {
    let t = DEFAULT_TARGET
    for (let i = 1; i < TIME_TIERS.length; i += 1) {
      t = nextTier(t)
      expect(t.secs).toBe(TIME_TIERS[i])
    }
    expect(nextTier({ secs: Infinity })).toEqual({ secs: Infinity })
  })

  it('steps shallow back through every tier', () => {
    let t = { secs: Infinity }
    for (let i = TIME_TIERS.length - 2; i >= 0; i -= 1) {
      t = prevTier(t)
      expect(t.secs).toBe(TIME_TIERS[i])
    }
    expect(prevTier(DEFAULT_TARGET).secs).toBe(DEFAULT_TIME)
  })

  it('treats a frozen (depth) target as deeper-than-default and steps to ∞ / 30s', () => {
    const frozen = { depth: 31 }
    expect(targetIsDeeper(frozen)).toBe(true)
    expect(targetIsInfinite(nextTier(frozen))).toBe(true)
    expect(prevTier(frozen).secs).toBe(30)
  })

  it('only saves completed evaluations at or above the save depth', () => {
    expect(canSavePositionEval({ eval: 0.2, depth: 30, searching: false })).toBe(true)
    expect(canSavePositionEval({ eval: 0.2, depth: 30, searching: true })).toBe(false)
    expect(canSavePositionEval({ eval: 0.2, depth: 18, searching: false })).toBe(false)
    expect(canSavePositionEval({ depth: 30, searching: false })).toBe(false)
  })
})

describe('usePositionEval search targets', () => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.get.mockResolvedValue({ data: null })
    // One SSE frame at depth 25, then the stream stays open (a live search).
    const frame = new TextEncoder().encode('data: {"depth":25,"eval":0.3,"lines":[]}\n\n')
    globalThis.fetch = vi.fn(() => {
      let sent = false
      return Promise.resolve({
        ok: true,
        body: {
          getReader: () => ({
            read: () => (sent
              ? new Promise(() => {})
              : (sent = true, Promise.resolve({ value: frame, done: false }))),
          }),
        },
      })
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops a frozen depth when the position changes', async () => {
    const { result, rerender } = renderHook(({ fen }) => usePositionEval(fen), {
      initialProps: { fen: START },
    })
    await waitFor(() => expect(result.current.localEval?.depth).toBe(25))

    act(() => result.current.freeze())
    expect(result.current.target).toEqual({ depth: 25 })

    // Carried over, every later position ran a fixed d25 search and saved evals
    // stopped auto-loading.
    rerender({ fen: AFTER_E4 })
    expect(result.current.target).toEqual(DEFAULT_TARGET)
  })

  it('marks the panel searching the moment the budget changes', async () => {
    const { result } = renderHook(() => usePositionEval(START))
    await waitFor(() => expect(result.current.localEval?.depth).toBe(25))

    act(() => result.current.deepen())
    expect(result.current.localEval).toMatchObject({ searching: true, depth: 0, saved: false })
  })
})
