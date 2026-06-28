import { useState } from 'react'
import Icon from './shared/Icon'
import ScorePill from './shared/ScorePill'
import InlineConfirm from './shared/InlineConfirm'

function VariationRow({ branch, active, onLoad, onDrill, onDelete }) {
  const plies = branch.moves_san.split(' ').filter(Boolean).length
  return (
    <div className={`op-var-row${active ? ' active' : ''}`}>
      <button
        type="button"
        className="op-var-main"
        onClick={() => onLoad(branch)}
        title={branch.note || branch.name}
      >
        <span className="op-var-name">{branch.name}</span>
        <span className="op-var-meta">{plies} move{plies === 1 ? '' : 's'}</span>
      </button>
      <ScorePill branch={branch} />
      <div className="op-row-actions">
        <button
          type="button"
          className="op-icon-btn"
          title={`Drill ${branch.name}`}
          aria-label={`Drill ${branch.name}`}
          onClick={() => onDrill(branch)}
        >
          <Icon name="play" size={13} filled />
        </button>
        {onDelete && <InlineConfirm title={`Delete ${branch.name}`} onConfirm={() => onDelete(branch)} />}
      </div>
    </div>
  )
}

/**
 * One opening "folder": a collapsible header (chevron · name · meta + hover
 * rename/delete) over its variation rows. `opening` is the entity (null for the
 * synthetic "Ungrouped" / unmatched-text folders, which can't be renamed).
 */
export default function OpeningFolder({
  name,
  label = name,
  branches,
  opening,
  expanded,
  onToggle,
  activeLineKey,
  onLoadBranch,
  onStartPractice,
  onDeleteBranch,
  onRenameOpening,
  onDeleteOpening,
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(name)
  const lines = branches.length
  const clean = branches.filter(b => b.drill_count && b.drill_solved === b.drill_count).length
  const canEdit = Boolean(opening)

  const submitRename = () => {
    setRenaming(false)
    const next = draft.trim()
    if (next && next !== name) onRenameOpening(opening, next)
  }

  const startRename = () => { setDraft(name); setRenaming(true) }

  return (
    <div className={`op-folder${expanded ? ' open' : ''}`}>
      <div className="op-folder-head">
        {renaming ? (
          <input
            className="op-folder-rename"
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => {
              if (e.key === 'Enter') submitRename()
              else if (e.key === 'Escape') { setRenaming(false); setDraft(name) }
            }}
            onBlur={submitRename}
            aria-label={`Rename ${name}`}
          />
        ) : (
          <button type="button" className="op-folder-toggle" onClick={onToggle} aria-expanded={expanded}>
            <Icon name="chevron" size={14} className="chev" />
            <span className="op-folder-name">{label}</span>
            <span className="op-folder-meta">{lines} line{lines === 1 ? '' : 's'}{clean ? ` · ${clean} clean` : ''}</span>
          </button>
        )}
        {canEdit && !renaming && (
          <div className="op-row-actions">
            <button
              type="button"
              className="op-icon-btn"
              title={`Rename ${name}`}
              aria-label={`Rename ${name}`}
              onClick={startRename}
            >
              <Icon name="pencil" size={14} />
            </button>
            <InlineConfirm title={`Delete ${name}`} onConfirm={() => onDeleteOpening(opening)} />
          </div>
        )}
      </div>

      {expanded && lines > 0 && (
        <div className="op-folder-body">
          {branches.map(b => (
            <VariationRow
              key={b.id}
              branch={b}
              active={b.moves_san === activeLineKey}
              onLoad={onLoadBranch}
              onDrill={onStartPractice}
              onDelete={onDeleteBranch}
            />
          ))}
        </div>
      )}

      {expanded && lines === 0 && (
        <div className="op-folder-empty">No lines yet. Play moves on the board, then save the line here.</div>
      )}
    </div>
  )
}

export { VariationRow }
