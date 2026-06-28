import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'

const DEBOUNCE_MS = 150

/**
 * Lichess Opening Explorer (all-games DB) move stats for the current FEN.
 *
 * Mirrors the cloud-eval half of usePositionEval: debounced + abortable, with a
 * render-phase reset to `null` the instant the position changes so stats from a
 * different position never linger. A same-position reload failure retains the
 * last successful payload and marks it stale.
 */
export function useOpeningExplorer(fen) {
  const [explorer, setExplorer] = useState(null)
  const [trackedFen, setTrackedFen] = useState(fen)
  const [reloadKey, setReloadKey] = useState(0)

  if (fen !== trackedFen) {
    setTrackedFen(fen)
    setExplorer(null)
  }

  useEffect(() => {
    if (!fen) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => {
      api.get('/opening-explorer', { params: { fen }, signal: controller.signal })
        .then((res) => {
          if (!controller.signal.aborted) setExplorer({ ...res.data, stale_error: false })
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setExplorer(previous => (
              previous?.source === 'lichess'
                ? { ...previous, stale_error: true }
                : { source: 'error' }
            ))
          }
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [fen, reloadKey])

  const reload = useCallback(() => {
    setExplorer(previous => (
      previous?.source === 'lichess' ? { ...previous, stale_error: false } : null
    ))
    setReloadKey(key => key + 1)
  }, [])

  return { explorer, reload }
}
