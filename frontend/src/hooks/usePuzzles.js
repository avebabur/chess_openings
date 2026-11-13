/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react'
import { api, errorText } from '../api'

const STORAGE_KEY = 'op_puzzle_choice'
const DEFAULT_CHOICE = { theme: 'mix', difficulty: 'easier' }

function readChoice() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (saved && typeof saved.theme === 'string' && typeof saved.difficulty === 'string') return saved
  } catch {
    // Unreadable storage: fall through to the default.
  }
  return DEFAULT_CHOICE
}

/**
 * Lichess puzzles: the themes with the user's record, the chosen theme and
 * difficulty (remembered in this browser), and fetching the next puzzle.
 */
export function usePuzzles({ enabled }) {
  const [summary, setSummary] = useState(null)
  const [choice, setChoiceState] = useState(readChoice)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await api.get('/puzzles')
      setSummary(res.data)
    } catch (err) {
      setError(errorText(err, 'Could not load the puzzle themes'))
    }
  }, [])

  useEffect(() => { if (enabled) load() }, [enabled, load])

  const setChoice = useCallback((patch) => {
    setChoiceState((current) => {
      const next = { ...current, ...patch }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // The choice still holds for this visit.
      }
      return next
    })
  }, [])

  /**
   * The next puzzle, or null (with `error` set). `theme`, when given, becomes
   * the chosen theme first, so "Next puzzle" stays on it.
   */
  const fetchNext = useCallback(async (theme) => {
    const params = typeof theme === 'string' ? { ...choice, theme } : choice
    if (params !== choice) setChoice({ theme })
    setLoading(true)
    setError('')
    try {
      const res = await api.get('/puzzles/next', { params })
      return res.data
    } catch (err) {
      setError(errorText(err, 'Could not get a puzzle from Lichess'))
      return null
    } finally {
      setLoading(false)
    }
  }, [choice, setChoice])

  const recordAttempt = useCallback(async (puzzleId, solved) => {
    try {
      await api.post(`/puzzles/${puzzleId}/attempts`, { solved })
      await load()
    } catch {
      // Progress is a convenience; a failed write must not interrupt the puzzle.
    }
  }, [load])

  return { summary, choice, setChoice, loading, error, fetchNext, recordAttempt }
}

/** `{ key: label }` for every theme in a summary. */
export function themeLabels(summary) {
  const out = {}
  for (const group of summary?.groups || []) {
    for (const theme of group.themes) out[theme.key] = theme.label
  }
  return out
}
