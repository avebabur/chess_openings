import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'

export function useAccountManager({ onDataChanged, reloadExplorer }) {
  const [profile, setProfile] = useState(null)
  const [profileError, setProfileError] = useState('')

  const reloadProfile = useCallback(
    () => api.get('/profile')
      .then((response) => {
        setProfile(response.data)
        setProfileError('')
        return response.data
      })
      .catch(() => {
        setProfileError('Could not load accounts')
        return null
      }),
    [],
  )

  useEffect(() => { reloadProfile() }, [reloadProfile])

  const accounts = useMemo(() => profile?.accounts || [], [profile])
  const activeSync = accounts.some(account => ['queued', 'running'].includes(account.sync_job?.status))

  useEffect(() => {
    if (!activeSync) return undefined
    const timer = window.setInterval(reloadProfile, 800)
    return () => window.clearInterval(timer)
  }, [activeSync, reloadProfile])

  const signature = accounts
    .map(account => `${account.id}:${account.sync_job?.id || ''}:${account.sync_job?.status || ''}`)
    .join('|')
  const previousSignature = useRef('')
  useEffect(() => {
    if (previousSignature.current && previousSignature.current !== signature && !activeSync) {
      onDataChanged?.()
    }
    previousSignature.current = signature
  }, [signature, activeSync, onDataChanged])

  const add = useCallback(async (platform, username) => {
    const response = await api.post('/accounts', { platform, username })
    await reloadProfile()
    return response
  }, [reloadProfile])

  const sync = useCallback(async (id) => {
    const response = await api.post(`/accounts/${id}/sync`)
    await reloadProfile()
    return response
  }, [reloadProfile])

  const cancelSync = useCallback(async (jobId) => {
    await api.delete(`/sync-jobs/${jobId}`)
    await reloadProfile()
  }, [reloadProfile])

  const remove = useCallback(async (id) => {
    await api.delete(`/accounts/${id}`)
    await reloadProfile()
    onDataChanged?.()
  }, [reloadProfile, onDataChanged])

  const saveToken = useCallback(async (token) => {
    await api.put('/settings/lichess-token', { token })
    await reloadProfile()
    reloadExplorer?.()
  }, [reloadProfile, reloadExplorer])

  return {
    profile,
    profileError,
    accounts,
    hasToken: Boolean(profile?.has_lichess_token),
    reloadProfile,
    add,
    sync,
    cancelSync,
    remove,
    saveToken,
  }
}
