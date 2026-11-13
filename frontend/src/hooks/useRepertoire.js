/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

export function useRepertoire(color) {
  const [repertoire, setRepertoire] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const requestId = useRef(0)

  const reload = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    setError(false)
    try {
      const res = await api.get('/repertoire/tree', { params: { color } })
      if (id !== requestId.current) return null
      setRepertoire(res.data)
      return res.data
    } catch {
      if (id === requestId.current) setError(true)
      return null
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [color])

  useEffect(() => {
    // A color switch invalidates both the in-flight effect request and any
    // explicit reload started for the previous color.
    setRepertoire(null)
    reload()
    return () => { requestId.current += 1 }
  }, [reload])

  return { repertoire, loading, error, reload }
}
