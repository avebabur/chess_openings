import { useState } from 'react'
import Icon from './Icon'

/**
 * Trash button that expands to an inline "Delete? ✓ ✕" confirm in place of a
 * blocking window.confirm(). Calls onConfirm() only after the check is clicked.
 */
export default function InlineConfirm({ onConfirm, title = 'Delete', label = 'Delete?' }) {
  const [open, setOpen] = useState(false)

  if (open) {
    return (
      <span className="inline-confirm" onClick={(e) => e.stopPropagation()}>
        <span className="inline-confirm-label">{label}</span>
        <button
          type="button"
          className="op-icon-btn danger"
          title="Confirm delete"
          aria-label="Confirm delete"
          onClick={(e) => { e.stopPropagation(); setOpen(false); onConfirm() }}
        >
          <Icon name="check" size={15} />
        </button>
        <button
          type="button"
          className="op-icon-btn"
          title="Cancel"
          aria-label="Cancel delete"
          onClick={(e) => { e.stopPropagation(); setOpen(false) }}
        >
          <Icon name="x" size={15} />
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      className="op-icon-btn danger"
      title={title}
      aria-label={title}
      onClick={(e) => { e.stopPropagation(); setOpen(true) }}
    >
      <Icon name="trash" size={15} />
    </button>
  )
}
