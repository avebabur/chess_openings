import { Fragment, useState } from 'react'
import TagChips from './shared/TagChips'
import ScorePill from './shared/ScorePill'
import Icon from './shared/Icon'

export default function LineEditor({
  saveTarget,
  currentLineTitle,
  lineChanged,
  conflictBranch,
  saveDraft,
  tagInput,
  suggestedName,
  pathLength,
  path = [],
  openingOptions,
  onSaveDraftChange,
  onTagInputChange,
  onTagKeyDown,
  onAddTag,
  onRemoveTag,
  onSave,
  onSaveAsNew,
  onStartPractice,
  onDelete,
  onStopEditing,
  onLoadConflict,
  onResetToSaved,
  onJumpToPath,
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div className="op-editor">
      <div className="op-editor-top">
        <button type="button" className="op-back" onClick={onStopEditing}>
          <Icon name="chevron" size={14} className="op-back-chev" />
          Back to list
        </button>
        <span className="op-editor-kind">{saveTarget ? 'Edit variation' : 'New variation'}</span>
      </div>

      <div className="op-editor-hero">
        <div className="op-editor-name-row">
          <input
            className="op-editor-name"
            value={saveDraft.name}
            onChange={e => onSaveDraftChange({ name: e.target.value })}
            placeholder={suggestedName || 'Name this line'}
            disabled={!pathLength}
            aria-label="Variation name"
          />
          {saveTarget && <ScorePill branch={saveTarget} />}
        </div>
        {path.length ? (
          <div className="op-editor-moves">
            {path.map((san, i) => (
              <Fragment key={`${i}-${san}`}>
                {i % 2 === 0 && <span className="op-move-num">{i / 2 + 1}.</span>}
                <button
                  type="button"
                  className="op-move-btn"
                  onClick={() => onJumpToPath(path.slice(0, i + 1))}
                  title={`Go to ${path.slice(0, i + 1).join(' ')}`}
                >
                  {san}
                </button>
              </Fragment>
            ))}
          </div>
        ) : (
          <p className="op-editor-line">{currentLineTitle}</p>
        )}
      </div>

      {lineChanged && (
        <div className="op-notice">
          <span>
            {conflictBranch ? (
              <>This exact line is already saved as <b>{conflictBranch.name}</b>.</>
            ) : (
              <>The board differs from the saved moves of <b>{saveTarget.name}</b>.</>
            )}
          </span>
          {conflictBranch ? (
            <button type="button" className="btn-ghost" onClick={() => onLoadConflict(conflictBranch)}>
              Open &ldquo;{conflictBranch.name}&rdquo;
            </button>
          ) : (
            <button type="button" className="btn-ghost" onClick={onResetToSaved}>
              Reset to saved
            </button>
          )}
        </div>
      )}

      <div className="op-editor-form">
        <label className="field">
          <span>Opening</span>
          <input
            list="op-opening-options"
            value={saveDraft.opening}
            onChange={e => onSaveDraftChange({ opening: e.target.value })}
            placeholder="e.g. Caro-Kann"
            disabled={!pathLength}
          />
        </label>
        <label className="field">
          <span>Tags</span>
          <div className={`tag-input${!pathLength ? ' disabled' : ''}`}>
            <TagChips tags={saveDraft.tags} onRemove={onRemoveTag} />
            <input
              className="tag-input-field"
              value={tagInput}
              onChange={e => onTagInputChange(e.target.value)}
              onKeyDown={onTagKeyDown}
              onBlur={() => onAddTag(tagInput)}
              placeholder={saveDraft.tags.length ? 'Add another…' : 'Add a tag, press Enter'}
              disabled={!pathLength}
            />
          </div>
        </label>
        <label className="field">
          <span>Note</span>
          <textarea
            value={saveDraft.note}
            onChange={e => onSaveDraftChange({ note: e.target.value })}
            placeholder="Optional: the idea behind this line, key plans, traps to watch for…"
            disabled={!pathLength}
            rows={3}
          />
        </label>
      </div>

      <div className="op-editor-actions">
        {confirmDelete ? (
          <div className="op-editor-confirm">
            <span>Delete this line?</span>
            <button type="button" className="btn-primary danger" onClick={() => onDelete(saveTarget)}>Delete</button>
            <button type="button" className="btn-ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="btn-primary"
              onClick={onSave}
              disabled={!pathLength || Boolean(conflictBranch)}
            >
              {lineChanged ? 'Update line' : saveTarget ? 'Save changes' : 'Save variation'}
            </button>
            {lineChanged && !conflictBranch && (
              <button type="button" className="btn-secondary" onClick={onSaveAsNew}>
                Save as new
              </button>
            )}
            <span className="op-editor-actions-spacer" />
            {saveTarget && (
              <>
                <button type="button" className="btn-secondary" onClick={() => onStartPractice(saveTarget)}>
                  Drill
                </button>
                <button type="button" className="btn-ghost danger" onClick={() => setConfirmDelete(true)}>
                  Delete
                </button>
              </>
            )}
          </>
        )}
      </div>

      <datalist id="op-opening-options">
        {openingOptions.map(o => <option key={o} value={o} />)}
      </datalist>
    </div>
  )
}
