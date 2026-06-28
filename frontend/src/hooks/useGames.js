/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

const PAGE_SIZE = 50

// Paginated game metadata for the Games browser. Filters by account + time
// control (both colors, newest first); `loadMore` appends the next page.
export function useGames({ accountId, timeClass }) {
  const [games, setGames] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const reqId = useRef(0)

  const fetchPage = useCallback((offset) => {
    const id = ++reqId.current
    setLoading(true)
    setError(false)
    return api.get('/games', {
      params: {
        limit: PAGE_SIZE, offset, time_class: timeClass,
        ...(accountId ? { account_id: accountId } : {}),
      },
    })
      .then((res) => {
        if (id !== reqId.current) return
        const data = res.data || {}
        setTotal(data.total || 0)
        setGames((prev) => (offset ? [...prev, ...(data.games || [])] : (data.games || [])))
        setLoading(false)
      })
      .catch(() => {
        if (id !== reqId.current) return
        setError(true)
        setLoading(false)
      })
  }, [accountId, timeClass])

  const reload = useCallback(() => fetchPage(0), [fetchPage])
  const loadMore = useCallback(() => fetchPage(games.length), [fetchPage, games.length])

  useEffect(() => { fetchPage(0) }, [fetchPage])

  return { games, total, loading, error, hasMore: games.length < total, loadMore, reload }
}
