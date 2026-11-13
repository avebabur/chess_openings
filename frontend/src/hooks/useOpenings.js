/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

// Named openings (repertoire_openings) for a color, with per-opening drill
// stats used by the trainer's selection screen.
export function useOpenings(color) {
  const [openings, setOpenings] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const requestId = useRef(0)

  const reload = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    setError(false)
    try {
      const res = await api.get('/repertoire/openings', { params: { color } })
      if (id !== requestId.current) return null
      setOpenings(res.data || [])
      return res.data
    } catch {
      if (id === requestId.current) setError(true)
      return null
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [color])

  useEffect(() => {
    // A color switch must not retain the previous color's openings.
    setOpenings([])
    reload()
    return () => { requestId.current += 1 }
  }, [reload])

  return { openings, loading, error, reload }
}
