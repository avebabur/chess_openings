import { useState } from 'react'

/**
 * The comment box under the board. It shows the saved comment for the position
 * on the board and saves when you leave the box (or press Cmd/Ctrl+Enter).
 * The draft follows the position: stepping to another move swaps it.
 */
export default function PositionNote({ fen, saved, onSave, error }) {
  const [draft, setDraft] = useState(saved)
  const [state, setState] = useState('idle') // idle | saving | saved

  // A new position, or the saved text arriving from the server: show it. The
  // "Saved" label survives the text coming back from our own save.
  const [source, setSource] = useState({ fen, saved })
  if (source.fen !== fen || source.saved !== saved) {
    setSource({ fen, saved })
    setDraft(saved)
    if (source.fen !== fen) setState('idle')
  }

  const dirty = draft.trim() !== saved.trim()

  const commit = async () => {
    if (!dirty || state === 'saving') return
    setState('saving')
    const ok = await onSave(fen, draft)
    setState(ok ? 'saved' : 'idle')
  }

  return (
    <div className="position-note">
      <textarea
        value={draft}
        onChange={(event) => { setDraft(event.target.value); setState('idle') }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.blur()
        }}
        placeholder="Comment on this position…"
        aria-label="Comment on this position"
        maxLength={4000}
        spellCheck
      />
      <span className="position-note-state" role="status">
        {error || (state === 'saving' ? 'Saving…' : dirty ? 'Not saved' : state === 'saved' ? 'Saved' : '')}
      </span>
    </div>
  )
}
