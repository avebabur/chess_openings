import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'

const DEBOUNCE_MS = 150

/**
 * Lichess Opening Explorer (all-games DB) move stats for the current FEN, optionally
 * narrowed by `filters` (speeds / rating bands / month range — see useExplorerFilters).
 *
 * Mirrors the cloud-eval half of usePositionEval: debounced + abortable, with a
 * render-phase reset to `null` the instant the position changes so stats from a
 * different position never linger. A same-position reload failure retains the
 * last successful payload and marks it stale.
 *
 * `filterKey` — not the filters object — is the effect dependency: it's stable across
 * renders and order-independent, so re-picking the same chips can't spin the fetch.
 */
export function useOpeningExplorer(fen, filters = null, filterKey = '') {
  const [explorer, setExplorer] = useState(null)
  const [trackedFen, setTrackedFen] = useState(fen)
  const [trackedFilterKey, setTrackedFilterKey] = useState(filterKey)
  const [reloadKey, setReloadKey] = useState(0)

  if (fen !== trackedFen || filterKey !== trackedFilterKey) {
    setTrackedFen(fen)
    setTrackedFilterKey(filterKey)
    setExplorer(null)
  }

  useEffect(() => {
    if (!fen) return undefined
    const controller = new AbortController()
    const params = { fen }
    if (filters?.speeds?.length) params.speeds = filters.speeds.join(',')
    if (filters?.ratings?.length) params.ratings = filters.ratings.join(',')
    if (filters?.since) params.since = filters.since
    if (filters?.until) params.until = filters.until
    const timer = setTimeout(() => {
      api.get('/opening-explorer', { params, signal: controller.signal })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filterKey stands in for filters
  }, [fen, filterKey, reloadKey])

  const reload = useCallback(() => {
    setExplorer(previous => (
      previous?.source === 'lichess' ? { ...previous, stale_error: false } : null
    ))
    setReloadKey(key => key + 1)
  }, [])

  return { explorer, reload }
}
