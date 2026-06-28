/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'

export function useRepertoire(color) {
  const [repertoire, setRepertoire] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const res = await api.get('/repertoire/tree', { params: { color } })
      setRepertoire(res.data)
      return res.data
    } catch {
      setError(true)
      return null
    } finally {
      setLoading(false)
    }
  }, [color])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(false)
    api.get('/repertoire/tree', { params: { color } })
      .then((res) => {
        if (alive) setRepertoire(res.data)
      })
      .catch(() => {
        if (!alive) return
        setError(true)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [color])

  return { repertoire, loading, error, reload }
}
