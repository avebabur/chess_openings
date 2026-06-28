import { useCallback, useRef, useState } from 'react'
import { api } from '../api'

export function drillEventKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `drill-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function useDrillPersistence(onSaved) {
  const [state, setState] = useState({ pending: false, error: '' })
  const retryRef = useRef(null)        // last failed attempt awaiting retry (or null)
  const inFlightRef = useRef(false)

  const send = useCallback(async (payload, success) => {
    // Refuse to start a new attempt while one is in flight or an earlier one
    // failed and hasn't been retried/cleared — otherwise the new attempt would
    // overwrite the retry target and the earlier result would be lost. The caller
    // surfaces the standing "Retry before continuing" error.
    if (inFlightRef.current || retryRef.current) return false
    inFlightRef.current = true
    const body = { ...payload, event_key: payload.event_key || drillEventKey() }
    setState({ pending: true, error: '' })
    try {
      const res = await api.post('/repertoire/drill-attempts', body)
      inFlightRef.current = false
      setState({ pending: false, error: '' })
      success?.(res.data)
      onSaved?.()
      return true
    } catch {
      retryRef.current = { body, success }
      inFlightRef.current = false
      setState({
        pending: false,
        error: 'Could not save this training result. Retry before continuing.',
      })
      return false
    }
  }, [onSaved])

  const retry = useCallback(() => {
    const pending = retryRef.current
    if (!pending || inFlightRef.current) return
    retryRef.current = null   // clear so send's guard allows the replay
    send(pending.body, pending.success)
  }, [send])

  const clear = useCallback(() => {
    retryRef.current = null
    inFlightRef.current = false
    setState({ pending: false, error: '' })
  }, [])

  return { ...state, send, retry, clear }
}
