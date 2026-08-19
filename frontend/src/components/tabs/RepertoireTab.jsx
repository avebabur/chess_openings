import { useMemo, useState } from 'react'
import { playStepSound } from '../../sounds'
import { openingFamily, openingVariation } from '../../utils/formatUtils'
import OpeningFolder from '../OpeningFolder'
import LineEditor from '../LineEditor'
import Icon from '../shared/Icon'

/** Top-level bucket a variation folder belongs under. Ungrouped stays its own. */
function familyOf(folder) {
  return folder.name === 'Ungrouped' ? 'Ungrouped' : (openingFamily(folder.name) || folder.name)
}

export default function RepertoireTab({
  color,
  path,
  editorOpen,
  saveTarget,
  editingBranch,
  currentLineTitle,
  lineChanged,
  conflictBranch,
  saveDraft,
  tagInput,
  suggestedName,
  saveFeedback,
  branches,
  groupedBranches,
  allTags,
  tagFilter,
  dueNodes,
  dueCount = 0,
  transpositions = [],
  openings,
  activeLineKey,
  currentChildren,
  openingOptions,
  onCreateOpening,
  onRenameOpening,
  onDeleteOpening,
  onSaveDraftChange,
  onTagInputChange,
  onTagKeyDown,
  onAddTag,
  onRemoveTag,
  onSave,
  onSaveAsNew,
  onStartPractice,
  onDeleteBranch,
  onStopEditing,
  onLoadBranch,
  onLoadConflict,
  onResetToSaved,
  onStartReview,
  onSetEditorOpen,
  onSetTagFilter,
  onJumpToPath,
  onPlayMove,
  savedAsTransposition = false,
}) {
  const [overrides, setOverrides] = useState({})
  const [conflictsOpen, setConflictsOpen] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  // Only the disagreements are worth interrupting for; plain transpositions are
  // reported in the payload but need no action.
  const conflicts = useMemo(
    () => transpositions.filter(item => item.conflict),
    [transpositions],
  )
  const [newOpening, setNewOpening] = useState('')
  const [showTagMenu, setShowTagMenu] = useState(false)

  // One folder per opening entity, then any unmatched text groups, then "Ungrouped".
  const folders = useMemo(() => {
    const byName = new Map(groupedBranches)
    const entityNames = new Set((openings || []).map(o => o.name))
    const out = []
    for (const o of (openings || [])) {
      const list = byName.get(o.name) || []
      if (tagFilter && list.length === 0) continue
      out.push({ key: `op-${o.id}`, name: o.name, opening: o, branches: list })
    }
    let ungrouped = null
    for (const [name, list] of groupedBranches) {
      if (name === 'Ungrouped') { ungrouped = list; continue }
      if (!entityNames.has(name)) out.push({ key: `txt-${name}`, name, opening: null, branches: list })
    }
    if (ungrouped && ungrouped.length) out.push({ key: 'ungrouped', name: 'Ungrouped', opening: null, branches: ungrouped })
    return out
  }, [openings, groupedBranches, tagFilter])

  // Group the variation folders under their opening family: Family → Variation →
  // Lines. Order follows `folders` (entities first, then text groups, then Ungrouped).
  const families = useMemo(() => {
    const map = new Map()
    for (const f of folders) {
      const fam = familyOf(f)
      if (!map.has(fam)) map.set(fam, [])
      map.get(fam).push(f)
    }
    return [...map.entries()].map(([family, variations]) => ({ family, variations }))
  }, [folders])

  // Default: open the first folder that actually has lines (skip empty ones) and
  // whichever folder holds the active line — plus the families that contain them.
  const defaultOpen = useMemo(() => {
    const s = new Set()
    const firstWithLines = folders.find(f => f.branches.length > 0) || folders[0]
    if (firstWithLines) { s.add(firstWithLines.key); s.add(`fam-${familyOf(firstWithLines)}`) }
    const active = folders.find(f => f.branches.some(b => b.moves_san === activeLineKey))
    if (active) { s.add(active.key); s.add(`fam-${familyOf(active)}`) }
    return s
  }, [folders, activeLineKey])

  const isOpen = key => (key in overrides ? overrides[key] : defaultOpen.has(key))
  const toggle = key => setOverrides(o => ({ ...o, [key]: !isOpen(key) }))

  const renderFolder = (f, label) => (
    <OpeningFolder
      key={f.key}
      name={f.name}
      label={label}
      branches={f.branches}
      opening={f.opening}
      expanded={isOpen(f.key)}
      onToggle={() => toggle(f.key)}
      activeLineKey={activeLineKey}
      onLoadBranch={onLoadBranch}
      onStartPractice={onStartPractice}
      onDeleteBranch={onDeleteBranch}
      onRenameOpening={onRenameOpening}
      onDeleteOpening={onDeleteOpening}
    />
  )

  const addOpening = () => {
    const name = newOpening.trim()
    if (!name) return
    onCreateOpening(name)
    setNewOpening('')
    setShowAdd(false)
  }

  if (editorOpen && path.length > 0) {
    return (
      <div className="tab-pane rep-pane editor-pane" role="tabpanel">
        <LineEditor
          saveTarget={saveTarget}
          currentLineTitle={currentLineTitle}
          lineChanged={lineChanged}
          conflictBranch={conflictBranch}
          saveDraft={saveDraft}
          tagInput={tagInput}
          suggestedName={suggestedName}
          pathLength={path.length}
          path={path}
          onJumpToPath={onJumpToPath}
          openingOptions={openingOptions}
          onSaveDraftChange={onSaveDraftChange}
          onTagInputChange={onTagInputChange}
          onTagKeyDown={onTagKeyDown}
          onAddTag={onAddTag}
          onRemoveTag={onRemoveTag}
          onSave={onSave}
          onSaveAsNew={onSaveAsNew}
          onStartPractice={onStartPractice}
          onDelete={onDeleteBranch}
          onStopEditing={editingBranch ? onStopEditing : () => onSetEditorOpen(false)}
          onLoadConflict={onLoadConflict}
          onResetToSaved={onResetToSaved}
        />
      </div>
    )
  }

  return (
    <div className="tab-pane rep-pane" role="tabpanel">
      <div className="rep-sticky">
        {dueNodes.length > 0 && (
          <button type="button" className="rep-due" onClick={onStartReview}>
            {/* dueCount is the real backlog; dueNodes is capped at 50 by the API. */}
            <span>{dueCount} position{dueCount === 1 ? '' : 's'} due for review</span>
            <span aria-hidden="true">→</span>
          </button>
        )}

        {conflicts.length > 0 && (
          <div className="rep-conflicts">
            <button
              type="button"
              className="rep-conflicts-toggle"
              aria-expanded={conflictsOpen}
              onClick={() => setConflictsOpen(open => !open)}
            >
              <span className={`op-caret${conflictsOpen ? ' open' : ''}`} aria-hidden="true" />
              {conflicts.length} position{conflicts.length === 1 ? '' : 's'} where your
              {' '}repertoire gives two different answers
            </button>
            {conflictsOpen && (
              <ul className="rep-conflict-list">
                {conflicts.map(item => (
                  <li key={item.epd}>
                    {item.moves.map(move => (
                      <button
                        key={move.path_san}
                        type="button"
                        onClick={() => onJumpToPath(move.path_san.split(' '))}
                      >
                        <b>{move.san}</b>
                        <span>after {move.prior_path_san || 'the start'}</span>
                      </button>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {path.length > 0 && (
          <div className={`op-saveline${saveTarget && !lineChanged ? ' saved' : ''}${lineChanged ? ' changed' : ''}`}>
            <div className="op-saveline-row">
              <div className="op-saveline-info">
                <span className="op-saveline-state">
                  {lineChanged ? 'Unsaved changes' : saveTarget ? '✓ In your repertoire' : 'Current line · not saved'}
                </span>
                <span className="op-saveline-name">{saveTarget?.name || currentLineTitle}</span>
                {savedAsTransposition && !lineChanged && (
                  // Same position, different move order. Saying so — and naming
                  // the stored order — stops this being saved a second time.
                  <span className="op-saveline-transposed">
                    saved as <button
                      type="button"
                      onClick={() => onJumpToPath(saveTarget.moves_san.split(' '))}
                    >{saveTarget.moves_san}</button>
                  </span>
                )}
              </div>
              <div className="op-saveline-actions">
                {conflictBranch ? (
                  <button type="button" className="btn-secondary" onClick={() => onLoadBranch(conflictBranch)}>
                    Open existing
                  </button>
                ) : lineChanged ? (
                  <>
                    <button type="button" className="btn-primary" onClick={onSave}>Update</button>
                    <button type="button" className="btn-ghost" onClick={onResetToSaved}>Reset</button>
                  </>
                ) : saveTarget ? (
                  <>
                    <button type="button" className="btn-primary" onClick={() => onStartPractice(saveTarget)}>Drill</button>
                    <button type="button" className="btn-ghost" onClick={() => onSetEditorOpen(true)}>Edit</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn-primary" onClick={onSave}>Save line</button>
                    <button type="button" className="btn-ghost" onClick={() => onSetEditorOpen(true)}>Details</button>
                  </>
                )}
              </div>
            </div>
            {currentChildren.length > 0 && (
              <div className="op-saveline-continue">
                <span className="op-continue-label">Continue</span>
                {currentChildren.map(child => (
                  <button
                    key={child.id}
                    type="button"
                    className="op-continue-move"
                    /* Extend the move order on the board rather than jumping to
                       this reply's own path — with replies gathered by position,
                       the two can differ and jumping would rewrite history. */
                    onClick={() => { playStepSound(child.san); onPlayMove(child.san) }}
                    title={child.drill_count ? `Drilled ${child.drill_solved}/${child.drill_count}` : 'Saved reply'}
                  >
                    {child.san}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {saveFeedback && <div className="rep-toast">{saveFeedback}</div>}

        <div className="op-list-head">
          <span className="op-list-title">Openings</span>
          <span className="op-list-count">{openings?.length || 0}</span>
          <div className="op-list-head-actions">
            {allTags.length > 0 && (
              <div className="op-tagfilter">
                <button
                  type="button"
                  className={`op-icon-btn${tagFilter ? ' on' : ''}`}
                  title="Filter by tag"
                  aria-label="Filter by tag"
                  onClick={() => setShowTagMenu(v => !v)}
                >
                  <Icon name="filter" size={15} />
                </button>
                {showTagMenu && (
                  <>
                    <div
                      onClick={() => setShowTagMenu(false)}
                      style={{ position: 'fixed', inset: 0, zIndex: 19 }}
                    />
                    <div className="op-tagfilter-menu">
                      <button
                        type="button"
                        className={tagFilter ? '' : 'on'}
                        onClick={() => { onSetTagFilter(null); setShowTagMenu(false) }}
                      >
                        All lines
                      </button>
                      {allTags.map(tag => (
                        <button
                          key={tag}
                          type="button"
                          className={tagFilter?.toLowerCase() === tag.toLowerCase() ? 'on' : ''}
                          onClick={() => { onSetTagFilter(tag); setShowTagMenu(false) }}
                        >
                          #{tag}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            <button
              type="button"
              className={`op-icon-btn${showAdd ? ' on' : ''}`}
              title="Add opening"
              aria-label="Add opening"
              onClick={() => setShowAdd(v => !v)}
            >
              <Icon name="plus" size={16} />
            </button>
          </div>
        </div>

        {showAdd && (
          <div className="op-list-add">
            <input
              autoFocus
              value={newOpening}
              onChange={e => setNewOpening(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); addOpening() }
                else if (e.key === 'Escape') { setShowAdd(false); setNewOpening('') }
              }}
              placeholder="New opening name (e.g. Caro-Kann)"
            />
            <button type="button" className="btn-secondary" onClick={addOpening} disabled={!newOpening.trim()}>
              Add
            </button>
          </div>
        )}

        {tagFilter && (
          <span className="op-activefilter">
            #{tagFilter}
            <button type="button" onClick={() => onSetTagFilter(null)} aria-label="Clear tag filter">×</button>
          </span>
        )}
      </div>

      <div className="op-folders">
        {folders.length ? (
          families.map(fam => {
            // Render flat (no family wrapper) for Ungrouped and for a lone
            // variation whose name is already the family — avoids "X › X".
            const flat = fam.family === 'Ungrouped'
              || (fam.variations.length === 1 && fam.variations[0].name === fam.family)
            if (flat) return fam.variations.map(f => renderFolder(f, f.name))

            const famKey = `fam-${fam.family}`
            const open = isOpen(famKey)
            const vcount = fam.variations.length
            const lines = fam.variations.reduce((n, f) => n + f.branches.length, 0)
            return (
              <div key={famKey} className={`op-family${open ? ' open' : ''}`}>
                <button
                  type="button"
                  className="op-family-head"
                  onClick={() => toggle(famKey)}
                  aria-expanded={open}
                >
                  <Icon name="chevron" size={14} className="chev" />
                  <span className="op-family-name">{fam.family}</span>
                  <span className="op-family-meta">
                    {vcount} variation{vcount === 1 ? '' : 's'} · {lines} line{lines === 1 ? '' : 's'}
                  </span>
                </button>
                {open && (
                  <div className="op-family-body">
                    {fam.variations.map(f => renderFolder(f, openingVariation(f.name) || 'Main line'))}
                  </div>
                )}
              </div>
            )
          })
        ) : branches.length ? (
          <div className="op-empty compact">No variations match #{tagFilter}.</div>
        ) : (
          <div className="op-empty compact">
            <strong>No saved variations yet</strong>
            <p>Play a line on the board, then &ldquo;Save line&rdquo;. {color === 'white' ? 'White' : 'Black'} lines you save can be drilled and reviewed on a schedule.</p>
          </div>
        )}
      </div>
    </div>
  )
}
