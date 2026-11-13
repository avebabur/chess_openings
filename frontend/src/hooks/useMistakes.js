/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorText } from '../api'

const POLL_MS = 1500
// With nothing running, look now and then for an analysis that a sync started.
const IDLE_POLL_MS = 10000

/**
 * The user's mistakes in their own games, and the background analysis that
 * finds them. The analysis runs on the backend (up to a minute a game), so
 * this polls its status until it ends and then reloads the list.
 */
export function useMistakes({ enabled, accountId }) {
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [job, setJob] = useState(null)

  // Only the newest request may answer, so switching account quickly cannot
  // leave the previous account's list on screen.
  const latestLoad = useRef(0)
  const load = useCallback(async () => {
    const request = ++latestLoad.current
    try {
      const res = await api.get('/mistakes', { params: accountId ? { account_id: accountId } : {} })
      if (request !== latestLoad.current) return
      setData(res.data)
      setLoadError('')
    } catch (err) {
      if (request !== latestLoad.current) return
      setLoadError(errorText(err, 'Could not load your mistakes'))
    }
  }, [accountId])

  const fetchJob = useCallback(async () => {
    try {
      const res = await api.get('/analysis')
      setJob(res.data)
    } catch (err) {
      setJob({ running: false, error: errorText(err, 'Lost contact with the analysis') })
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    load()
    fetchJob()
  }, [enabled, load, fetchJob])

  // While games are being analysed, show each one as it lands.
  const running = Boolean(job?.running)
  const done = job?.done ?? 0
  useEffect(() => {
    if (!enabled) return undefined
    const timer = window.setTimeout(fetchJob, running ? POLL_MS : IDLE_POLL_MS)
    return () => window.clearTimeout(timer)
  }, [enabled, running, job, fetchJob])
  const seen = useRef({ running: false, done: 0 })
  useEffect(() => {
    const before = seen.current
    if ((before.running && !running) || (running && done !== before.done)) load()
    seen.current = { running, done }
  }, [running, done, load])

  const start = useCallback(async (count) => {
    try {
      const res = await api.post('/analysis', { count, ...(accountId ? { account_id: accountId } : {}) })
      setJob(res.data)
    } catch (err) {
      setJob({ running: false, error: errorText(err, 'Could not start the analysis') })
    }
  }, [accountId])

  const stop = useCallback(async () => {
    try {
      await api.delete('/analysis')
    } catch {
      // The next poll shows whatever state it is really in.
    }
  }, [])

  /** Count a finished try, and refresh the marks in the list. */
  const recordAttempt = useCallback(async (mistakeId, solved) => {
    try {
      await api.post(`/mistakes/${mistakeId}/attempts`, { solved })
      await load()
    } catch {
      // Progress is a convenience; a failed write must not interrupt the game.
    }
  }, [load])

  return { data, loadError, job, start, stop, recordAttempt }
}

/** Every mistake in list order, each with the game it came from. */
export function allMistakes(data) {
  const out = []
  for (const game of data?.games || []) {
    for (const mistake of game.mistakes) out.push({ mistake, game })
  }
  return out
}

/** The next mistake after `mistakeId` that is not fixed yet, or null. */
export function nextMistakeAfter(data, mistakeId) {
  const all = allMistakes(data)
  const index = all.findIndex(item => item.mistake.id === mistakeId)
  if (index < 0) return null
  return all.slice(index + 1).find(item => item.mistake.progress.last_result !== 'solved') || null
}

/** "12. Qh5" for White's move, "12... Qh5" for Black's. */
export function moveLabel(ply, san) {
  return `${Math.floor(ply / 2) + 1}${ply % 2 ? '...' : '.'} ${san}`
}

export function opponentOf(game) {
  return (game.user_color === 'white' ? game.black : game.white) || 'Unknown'
}
