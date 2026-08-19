import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { positionKeyFromFen } from '../domain/chessLine'

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
 *
 * Keyed on the *position*, not the raw FEN: the halfmove/fullmove counters differ
 * between move orders that reach the same board, and the backend collapses those to
 * one cache row anyway (lichess_explorer._cache_key). Comparing position keys means
 * navigating into a transposition reuses the result instead of refetching it.
 */
export function useOpeningExplorer(fen, filters = null, filterKey = '') {
  const positionKey = positionKeyFromFen(fen)
  const [explorer, setExplorer] = useState(null)
  const [trackedKey, setTrackedKey] = useState(positionKey)
  const [trackedFilterKey, setTrackedFilterKey] = useState(filterKey)
  const [reloadKey, setReloadKey] = useState(0)

  if (positionKey !== trackedKey || filterKey !== trackedFilterKey) {
    setTrackedKey(positionKey)
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
    // filterKey stands in for filters, and positionKey for fen: two move orders
    // reaching one position must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionKey, filterKey, reloadKey])

  const reload = useCallback(() => {
    setExplorer(previous => (
      previous?.source === 'lichess' ? { ...previous, stale_error: false } : null
    ))
    setReloadKey(key => key + 1)
  }, [])

  return { explorer, reload }
}
