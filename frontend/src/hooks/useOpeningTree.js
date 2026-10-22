/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

export function useOpeningTree({ color, pathKey, timeClass, accountId, enabled = true }) {
  const [tree, setTree] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const reqId = useRef(0)
  // The request a newer one supersedes is cancelled, not just ignored: holding
  // an arrow key otherwise leaves one tree request per ply running to the end.
  const inFlight = useRef(null)

  const reload = useCallback(() => {
    inFlight.current?.abort()
    // Stand down while disabled (e.g. reviewing a full game) so stepping
    // through positions doesn't fire a tree request per ply.
    if (!enabled) {
      ++reqId.current
      setLoading(false)
      return
    }
    const id = ++reqId.current
    const controller = new AbortController()
    inFlight.current = controller
    setLoading(true)
    setError(false)
    api.get('/opening-tree', {
      params: {
        color, path: pathKey, time_class: timeClass,
        ...(accountId ? { account_id: accountId } : {}),
      },
      signal: controller.signal,
    })
      .then((res) => {
        if (id !== reqId.current) return
        setTree(res.data)
        setLoading(false)
      })
      .catch(() => {
        if (id !== reqId.current) return
        setError(true)
        setLoading(false)
      })
  }, [color, pathKey, timeClass, accountId, enabled])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => () => inFlight.current?.abort(), [])

  return { tree, loading, error, reload }
}
