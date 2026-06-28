import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TARGET,
  DEFAULT_TIME,
  TIME_TIERS,
  canSavePositionEval,
  nextTier,
  prevTier,
  targetIsDeeper,
  targetIsInfinite,
} from './usePositionEval'

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
