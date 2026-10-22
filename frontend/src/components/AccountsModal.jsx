import { useState } from 'react'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { API } from '../api'

const PLATFORMS = [
  { key: 'chesscom', label: 'Chess.com' },
  { key: 'lichess', label: 'Lichess' },
]

const TOKEN_URL = 'https://lichess.org/account/oauth/token/create?description=Chess+Openings+explorer'

function syncedLabel(iso) {
  if (!iso) return 'never synced'
  const ms = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  if (Number.isNaN(ms)) return 'synced'
  const secs = Math.max(0, (Date.now() - ms) / 1000)
  if (secs < 90) return 'synced just now'
  if (secs < 3600) return `synced ${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `synced ${Math.floor(secs / 3600)}h ago`
  return `synced ${Math.floor(secs / 86400)}d ago`
}

/** Manage tracked accounts (add/import/sync/remove) + the Lichess explorer token.
 *  Handlers are async and reject with an axios error on failure. */
export default function AccountsModal({ accounts, hasToken, onAdd, onSync, onCancelSync, onDelete, onSaveToken, onClose }) {
  const [platform, setPlatform] = useState('chesscom')
  const [username, setUsername] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [token, setToken] = useState('')
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenMsg, setTokenMsg] = useState('')
  const [confirmId, setConfirmId] = useState(null)
  const dialogRef = useDialogFocusTrap(onClose)

  const add = async (e) => {
    e.preventDefault()
    const u = username.trim()
    if (!u) return
    setAdding(true)
    setError('')
    try {
      await onAdd(platform, u)
      setUsername('')
    } catch (err) {
      setError(err?.response?.data?.detail || 'Could not add this account')
    } finally {
      setAdding(false)
    }
  }

  const sync = async (id) => {
    setBusyId(id)
    setError('')
    try {
      await onSync(id)
    } catch (err) {
      setError(err?.response?.data?.detail || 'Sync failed')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (acct) => {
    if (confirmId !== acct.id) {
      setConfirmId(acct.id)
      return
    }
    setBusyId(acct.id)
    setError('')
    try {
      await onDelete(acct.id)
      setConfirmId(null)
    } catch {
      setError('Could not remove this account')
    } finally {
      setBusyId(null)
    }
  }

  const cancelSync = async (jobId) => {
    setError('')
    try {
      await onCancelSync(jobId)
    } catch {
      setError('Could not cancel sync')
    }
  }

  // Saving and removing are separate actions on purpose: an empty Save used to
  // clear the stored token, so clicking Save on the "paste to replace" field
  // silently broke the players explorer.
  const writeToken = async (value) => {
    setTokenBusy(true)
    setTokenMsg('')
    try {
      await onSaveToken(value)
      setTokenMsg(value ? 'Token saved — the players explorer will work now.' : 'Token removed.')
      setToken('')
    } catch {
      setTokenMsg(value ? 'Could not save the token' : 'Could not remove the token')
    } finally {
      setTokenBusy(false)
    }
  }

  const saveToken = (e) => {
    e.preventDefault()
    const trimmed = token.trim()
    if (trimmed) writeToken(trimmed)
  }

  return (
    <div className="op-modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="op-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Manage accounts"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="op-modal-head">
          <h2>Accounts</h2>
          <button type="button" className="op-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="op-modal-body">
          <p className="op-modal-intro">
            Track several chess.com / Lichess accounts. Each account's games are imported and explorable
            on their own or combined via “All accounts”.
          </p>

          <ul className="op-account-list">
            {accounts.length === 0 && (
              <li className="op-account-empty">No accounts yet — add one below.</li>
            )}
            {accounts.map((a) => (
              <li key={a.id} className="op-account-item">
                <div className="op-account-info">
                  <span className={`op-account-badge ${a.platform}`}>
                    {a.platform === 'lichess' ? 'Lichess' : 'Chess.com'}
                  </span>
                  <span className="op-account-name">{a.username}</span>
                  <span className="op-account-sub">
                    {a.games.toLocaleString()} games · {syncedLabel(a.last_synced_at)}
                  </span>
                  {a.sync_job?.status === 'running' || a.sync_job?.status === 'queued' ? (
                    <span className="op-account-sync" role="status">
                      {a.sync_job.status === 'queued' ? 'Sync queued' : `Syncing · ${a.sync_job.seen.toLocaleString()} checked · ${a.sync_job.imported.toLocaleString()} new`}
                    </span>
                  ) : a.sync_job?.status === 'failed' ? (
                    <span className="op-account-sync error" role="alert">{a.sync_job.error || 'Sync failed'}</span>
                  ) : a.sync_job?.status === 'warning' ? (
                    <span className="op-account-sync warning">Synced with warnings: {a.sync_job.warnings?.join('; ')}</span>
                  ) : null}
                </div>
                <div className="op-account-actions">
                  {['queued', 'running'].includes(a.sync_job?.status) ? (
                    <button type="button" className="chip" onClick={() => cancelSync(a.sync_job.id)}>Cancel</button>
                  ) : (
                    <button type="button" className="chip" disabled={busyId === a.id} onClick={() => sync(a.id)}>
                      {busyId === a.id ? '…' : 'Sync'}
                    </button>
                  )}
                  {confirmId === a.id ? (
                    <span className="op-remove-confirm">
                      <button type="button" className="chip danger" disabled={busyId === a.id} onClick={() => remove(a)}>Confirm remove</button>
                      <button type="button" className="chip" onClick={() => setConfirmId(null)}>Cancel</button>
                    </span>
                  ) : (
                    <button type="button" className="chip danger" disabled={busyId === a.id || ['queued', 'running'].includes(a.sync_job?.status)} onClick={() => remove(a)}>
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <form className="op-account-add" onSubmit={add}>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Platform">
              {PLATFORMS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
            <input
              type="text"
              placeholder="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-label="Account username"
              autoComplete="off"
            />
            <button type="submit" className="btn-primary" disabled={adding || !username.trim()}>
              {adding ? 'Importing…' : 'Add & import'}
            </button>
          </form>
          {error && <p className="op-account-error">{error}</p>}

          <div className="op-backup-section">
            <h3>Data backup</h3>
            <p className="op-token-help">Download a consistent SQLite backup. It includes games, repertoire, review history, and your saved Lichess token; store it securely.</p>
            <a className="btn-secondary" href={`${API}/backup`} download>Download backup</a>
          </div>

          <div className="op-token-section">
            <h3>Lichess explorer token {hasToken && <span className="op-token-ok">saved</span>}</h3>
            <p className="op-token-help">
              Lichess now requires a token for the “Lichess players” explorer. Create a free token at{' '}
              <a href={TOKEN_URL} target="_blank" rel="noreferrer">lichess.org → API tokens</a>{' '}
              (no scopes needed) and paste it here.
            </p>
            <form className="op-token-form" onSubmit={saveToken}>
              <input
                type="password"
                placeholder={hasToken ? '•••••••• (paste to replace)' : 'lip_…'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                aria-label="Lichess API token"
                autoComplete="off"
              />
              <button type="submit" className="btn-primary" disabled={tokenBusy || !token.trim()}>
                {tokenBusy ? 'Saving…' : 'Save'}
              </button>
              {hasToken && (
                <button type="button" className="btn-ghost danger" disabled={tokenBusy} onClick={() => writeToken('')}>
                  Remove
                </button>
              )}
            </form>
            {tokenMsg && <p className="op-token-msg">{tokenMsg}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
