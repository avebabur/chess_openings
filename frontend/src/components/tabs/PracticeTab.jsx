import { TRAINER_STATUS } from '../../domain/openingTrainer'
import Icon from '../shared/Icon'

const AWAITING = [TRAINER_STATUS.AWAITING_USER_MOVE, TRAINER_STATUS.WRONG_MOVE_FEEDBACK]

function PickRow({ title, meta, score, scoreClean, primary = false, onTrain }) {
  return (
    <button type="button" className={`op-pick${primary ? ' primary' : ''}`} onClick={onTrain}>
      <span className="op-pick-name">{title}</span>
      <span className="op-pick-meta">{meta}</span>
      {score != null && <span className={`score-pill${scoreClean ? ' clean' : ''}`}>{score}</span>}
      <Icon name="play" size={13} filled className="op-pick-go" />
    </button>
  )
}

export default function PracticeTab({
  trainer,
  color,
  openings,
  branches,
  ungroupedBranches,
  expectedHintSan,
  drillWrite,
  onRetryWrite,
  onStartOpening,
  onStartUngrouped,
  onStartAll,
  onContinue,
  onExit,
  onOpenRepertoire,
}) {
  // --- Selection screen ---
  if (!trainer) {
    const colorLabel = color === 'white' ? 'White' : 'Black'
    const trainable = (openings || []).filter(o => o.lines > 0)

    if (!branches.length) {
      return (
        <div className="tab-pane" role="tabpanel">
          <div className="op-pane-head">
            <div className="op-pane-head-text">
              <h2>Nothing to train yet</h2>
              <p>Save a variation first, then drill it here.</p>
            </div>
          </div>
          <div className="op-empty compact">
            <strong>No saved lines</strong>
            <p>Open Repertoire, play a line on the board, then save it under an opening.</p>
            <button type="button" className="btn-secondary" onClick={onOpenRepertoire}>Open Repertoire</button>
          </div>
        </div>
      )
    }

    return (
      <div className="tab-pane" role="tabpanel">
        <div className="op-pane-head">
          <div className="op-pane-head-text">
            <h2>Train as {colorLabel}</h2>
            <p>Pick an opening to drill, or train everything. The opponent replies from your lines — a random branch each run.</p>
          </div>
          <button type="button" className="btn-secondary" onClick={onOpenRepertoire}>Manage</button>
        </div>

        <div className="op-picklist">
          <PickRow
            primary
            title="Train everything"
            meta={`${branches.length} line${branches.length === 1 ? '' : 's'} · all openings`}
            onTrain={onStartAll}
          />
          {trainable.map(o => (
            <PickRow
              key={o.id}
              title={o.name}
              meta={`${o.lines} line${o.lines === 1 ? '' : 's'} · ${o.trained} trained`}
              score={`${o.clean}/${o.lines}`}
              scoreClean={o.lines > 0 && o.clean === o.lines}
              onTrain={() => onStartOpening(o)}
            />
          ))}
          {ungroupedBranches.length > 0 && (
            <PickRow
              title="Ungrouped lines"
              meta={`${ungroupedBranches.length} line${ungroupedBranches.length === 1 ? '' : 's'} · no opening`}
              onTrain={onStartUngrouped}
            />
          )}
        </div>
      </div>
    )
  }

  // --- Active run ---
  const colorLabel = trainer.userColor === 'white' ? 'White' : 'Black'
  const { status, feedback, linesDone, linesTotal, cleanLines } = trainer
  const lastLine = trainer.remaining.size === 0

  return (
    <div className="tab-pane" role="tabpanel">
      <div className="practice-session">
        <div className="practice-header">
          <div>
            <span className="eyebrow">Training as {colorLabel}</span>
            <strong>{trainer.scope?.label || 'Openings'}</strong>
          </div>
          <button type="button" className="btn-secondary" onClick={onExit}>Exit</button>
        </div>

        <div className="op-statline">
          <div className="op-stat">
            <span className="op-stat-label">Lines done</span>
            <span className="op-stat-num">{linesDone}/{linesTotal}</span>
          </div>
          <div className="op-stat">
            <span className="op-stat-label">Clean</span>
            <span className={`op-stat-num${cleanLines ? ' good' : ''}`}>{cleanLines}</span>
          </div>
        </div>

        {AWAITING.includes(status) && (
          <div className="practice-card active">
            <strong>Your move</strong>
            <p>
              {status === TRAINER_STATUS.WRONG_MOVE_FEEDBACK && feedback?.playedSan
                ? `${feedback.playedSan} isn't in your repertoire here. `
                : `Play your reply for ${colorLabel}. `}
              The opponent picked this line at random.
            </p>
            {trainer.hint && expectedHintSan && (
              <span className="practice-hint">Hint: {expectedHintSan}</span>
            )}
          </div>
        )}

        {drillWrite?.error && (
          <div className="review-write-error" role="alert">
            <span>{drillWrite.error}</span>
            <button type="button" className="btn-secondary" onClick={onRetryWrite}>Retry</button>
          </div>
        )}

        {drillWrite?.pending && (
          <div className="review-write-error" role="status">
            <span>Saving result…</span>
          </div>
        )}

        {status === TRAINER_STATUS.AUTOPLAYING_OPPONENT && (
          <div className="practice-card">
            <strong>Opponent playing</strong>
            <p>{trainer.lastSan ? `${trainer.lastSan} played.` : 'Choosing a line…'}</p>
          </div>
        )}

        {status === TRAINER_STATUS.LINE_COMPLETE && (
          <div className={`practice-card ${trainer.lineMisses.length === 0 ? 'success' : ''}`}>
            <strong>{trainer.lineMisses.length === 0 ? 'Clean line' : 'Line complete'}</strong>
            <p>
              {trainer.lineMisses.length === 0
                ? 'No misses on that line.'
                : `${trainer.lineMisses.length} miss${trainer.lineMisses.length > 1 ? 'es' : ''} added to Review.`}
              {lastLine ? ' That was the last line in this run.' : ''}
            </p>
            <div className="practice-done-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={onContinue}
                disabled={drillWrite?.pending || Boolean(drillWrite?.error) || !trainer.lineRecorded}
              >
                {drillWrite?.pending || !trainer.lineRecorded
                  ? 'Saving…'
                  : lastLine ? 'Finish' : `Continue training (${linesDone}/${linesTotal})`}
              </button>
              <button type="button" className="btn-secondary" onClick={onExit}>Exit</button>
            </div>
          </div>
        )}

        {status === TRAINER_STATUS.RUN_COMPLETE && (
          <div className="practice-card success">
            <strong>All {linesTotal} line{linesTotal === 1 ? '' : 's'} trained</strong>
            <p>{cleanLines} clean. Nice work.</p>
            <div className="practice-done-actions">
              <button type="button" className="btn-secondary" onClick={onExit}>Back to openings</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
