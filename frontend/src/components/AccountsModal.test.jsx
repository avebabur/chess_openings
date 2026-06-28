import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AccountsModal from './AccountsModal'

afterEach(cleanup)

describe('AccountsModal keyboard behavior', () => {
  it('takes focus, closes with Escape, and restores prior focus', () => {
    const prior = document.createElement('button')
    document.body.appendChild(prior)
    prior.focus()
    const onClose = vi.fn()
    const { getByRole, unmount } = render(
      <AccountsModal
        accounts={[]}
        hasToken={false}
        onAdd={vi.fn()}
        onSync={vi.fn()}
        onDelete={vi.fn()}
        onSaveToken={vi.fn()}
        onClose={onClose}
      />,
    )

    expect(document.activeElement).toBe(getByRole('button', { name: 'Close' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()

    unmount()
    expect(document.activeElement).toBe(prior)
    prior.remove()
  })

  it('shows persisted sync progress and cancellation without a browser confirm dialog', () => {
    const onCancelSync = vi.fn().mockResolvedValue()
    const onDelete = vi.fn().mockResolvedValue()
    const view = render(
      <AccountsModal
        accounts={[{
          id: 1, username: 'player', platform: 'chesscom', games: 12,
          last_synced_at: null,
          sync_job: { id: 'job-1', status: 'running', seen: 42, imported: 3 },
        }]}
        hasToken={false}
        onAdd={vi.fn()}
        onSync={vi.fn()}
        onCancelSync={onCancelSync}
        onDelete={onDelete}
        onSaveToken={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(view.getByRole('status').textContent).toContain('42 checked')
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
    expect(onCancelSync).toHaveBeenCalledWith('job-1')
    expect(view.getByRole('link', { name: 'Download backup' }).getAttribute('href')).toContain('/backup')
  })
})
