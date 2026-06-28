/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'

// Named openings (repertoire_openings) for a color, with per-opening drill
// stats used by the trainer's selection screen.
export function useOpenings(color) {
  const [openings, setOpenings] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const res = await api.get('/repertoire/openings', { params: { color } })
      setOpenings(res.data || [])
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
    api.get('/repertoire/openings', { params: { color } })
      .then((res) => { if (alive) setOpenings(res.data || []) })
      .catch(() => { if (!alive) return; setError(true) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [color])

  return { openings, loading, error, reload }
}
