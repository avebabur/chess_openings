/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

const POLL_MS = 1500

function errorText(err, fallback) {
  const detail = err?.response?.data?.detail
  return typeof detail === 'string' ? detail : (err?.message || fallback)
}

/**
 * The Lichess Practice library: the imported sets with the user's progress,
 * plus the import itself. The import runs on the backend (it takes a minute:
 * Lichess allows one request at a time), so this polls its status until it ends.
 */
export function usePracticeLibrary({ enabled }) {
  const [library, setLibrary] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [importState, setImportState] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get('/practice/library')
      setLibrary(res.data)
      setLoadError('')
    } catch (err) {
      setLoadError(errorText(err, 'Could not load the practice library'))
    }
  }, [])

  const fetchImportStatus = useCallback(async () => {
    try {
      const res = await api.get('/practice/import')
      setImportState(res.data)
    } catch (err) {
      setImportState({ running: false, error: errorText(err, 'Lost contact with the import') })
    }
  }, [])

  // On opening: show the library, and pick up an import that is already running.
  useEffect(() => {
    if (!enabled) return
    load()
    fetchImportStatus()
  }, [enabled, load, fetchImportStatus])

  // While an import runs, ask how far it got until it ends, then show the result.
  const running = Boolean(importState?.running)
  useEffect(() => {
    if (!running) return undefined
    const timer = window.setTimeout(fetchImportStatus, POLL_MS)
    return () => window.clearTimeout(timer)
  }, [running, importState, fetchImportStatus])
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !running) load()
    wasRunning.current = running
  }, [running, load])

  const startImport = useCallback(async () => {
    try {
      const res = await api.post('/practice/import')
      setImportState(res.data)
    } catch (err) {
      setImportState({ running: false, error: errorText(err, 'Could not start the import') })
    }
  }, [])

  /** Count a finished attempt, and refresh the progress shown in the library. */
  const recordAttempt = useCallback(async (positionId, solved) => {
    try {
      await api.post(`/practice/positions/${positionId}/attempts`, { solved })
      await load()
    } catch {
      // Progress is a convenience; a failed write must not interrupt the game.
    }
  }, [load])

  return { library, loadError, importState, startImport, recordAttempt, reload: load }
}

/** Every position you can be judged on, in library order. */
export function playablePositions(library) {
  const out = []
  for (const section of library?.sections || []) {
    for (const set of section.sets) {
      for (const position of set.positions) {
        if (position.goal.kind !== 'study') out.push({ ...position, setTitle: set.title })
      }
    }
  }
  return out
}

/** The playable position after `positionId`, or null at the end. */
export function nextPositionAfter(library, positionId) {
  const all = playablePositions(library)
  const index = all.findIndex(position => position.id === positionId)
  return index >= 0 && index + 1 < all.length ? all[index + 1] : null
}
