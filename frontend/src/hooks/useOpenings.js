/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

// Named openings (repertoire_openings) for a color, with per-opening drill
// stats used by the trainer's selection screen.
export function useOpenings(color) {
  const [openings, setOpenings] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  // Newest load wins, as in useRepertoire: a reload for the previous color must
  // not overwrite this one's list.
  const reqId = useRef(0)

  const reload = useCallback(async () => {
    const id = ++reqId.current
    setLoading(true)
    setError(false)
    try {
      const res = await api.get('/repertoire/openings', { params: { color } })
      if (id !== reqId.current) return null
      setOpenings(res.data || [])
      return res.data
    } catch {
      if (id === reqId.current) setError(true)
      return null
    } finally {
      if (id === reqId.current) setLoading(false)
    }
  }, [color])

  useEffect(() => {
    reload()
    return () => { reqId.current += 1 }
  }, [reload])

  return { openings, loading, error, reload }
}
