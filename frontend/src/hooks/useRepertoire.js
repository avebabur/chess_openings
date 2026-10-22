/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

export function useRepertoire(color) {
  const [repertoire, setRepertoire] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  // Every load — the color-change effect and each explicit reload() — takes a
  // ticket, and only the newest may write. A reload issued for White (after a
  // save or drill) that lands after the user switched to Black would otherwise
  // replace Black's repertoire with White's.
  const reqId = useRef(0)

  const reload = useCallback(async () => {
    const id = ++reqId.current
    setLoading(true)
    setError(false)
    try {
      const res = await api.get('/repertoire/tree', { params: { color } })
      if (id !== reqId.current) return null
      setRepertoire(res.data)
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

  return { repertoire, loading, error, reload }
}
