import { REVIEW_STATUS } from '../../domain/reviewSession'
import { formatMoveLine } from '../../utils/formatUtils'

export default function ReviewTab({
  review,
  reviewItem,
  reviewPriorPath,
  dueNodes,
  duePreview,
  branches,
  trainedBranches,
  onStartReview,
  onFinishReview,
  onNextReview,
  onCompleteReview,
  reviewWrite,
  onRetryReviewWrite,
  onOpenPractice,
  onJumpToPath,
  onClearReview,
  onSetActiveTab,
}) {
  if (reviewItem) {
    return (
      <div className="tab-pane" role="tabpanel">
        <div className="review-session">
          <div className="practice-header">
            <div>
              <span className="eyebrow">Spaced review · {review.idx + 1} of {review.queue.length}</span>
              <strong>{formatMoveLine(reviewPriorPath, 12) || 'Starting position'}</strong>
            </div>
            <button type="button" className="btn-secondary" onClick={onFinishReview} disabled={reviewWrite.pending}>End review</button>
          </div>

          {review.status === REVIEW_STATUS.ASKING ? (
            <div className="practice-card active">
              <strong>What&apos;s your move?</strong>
              <p>Play {reviewItem.color === 'white' ? 'White' : 'Black'}&apos;s move from this position on the board.</p>
            </div>
          ) : (
            <div className={`practice-card ${review.wrong ? 'miss' : 'success'}`}>
              <strong>{review.wrong ? 'Not quite' : 'Correct ✓'}</strong>
              <p>
                {review.wrong
                  ? <>You played <b>{review.playedSan}</b>. Correct move: <b>{reviewItem.san}</b>.</>
                  : <>Correct move: <b>{reviewItem.san}</b>.</>}
              </p>
              <button
                type="button"
                className="btn-primary"
                onClick={review.idx + 1 >= review.queue.length ? onCompleteReview : onNextReview}
                disabled={reviewWrite.pending || Boolean(reviewWrite.error)}
              >
                {reviewWrite.pending
                  ? 'Saving…'
                  : review.idx + 1 >= review.queue.length ? 'Finish' : 'Next position'}
              </button>
              {reviewWrite.error && (
                <div className="review-write-error" role="alert">
                  <span>{reviewWrite.error}</span>
                  <button type="button" className="btn-secondary" onClick={onRetryReviewWrite}>Retry</button>
                </div>
              )}
            </div>
          )}

          <div className="review-scoreline">
            <span className="review-score-ok">{review.solved} correct</span>
            <span className="review-score-miss">{review.missed} missed</span>
          </div>
        </div>
      </div>
    )
  }

  if (review) {
    return (
      <div className="tab-pane" role="tabpanel">
        <div className="review-summary">
          <div className="pane-intro">
            <h2>Review complete</h2>
            <p>
              You reviewed {review.solved + review.missed} position{review.solved + review.missed === 1 ? '' : 's'}:
              {' '}{review.solved} correct, {review.missed} missed. Misses come back sooner; correct ones move further out.
            </p>
          </div>
          <button type="button" className="btn-primary" onClick={onFinishReview}>Done</button>
        </div>
      </div>
    )
  }

  return (
    <div className="tab-pane" role="tabpanel">
      <div className="op-pane-head">
        <div className="op-pane-head-text">
          <h2>{dueNodes.length ? `${dueNodes.length} due position${dueNodes.length === 1 ? '' : 's'}` : 'Nothing due'}</h2>
          <p>{dueNodes.length ? 'Recall the saved move from each position.' : 'Missed drill moves return here on a spaced schedule.'}</p>
        </div>
        {dueNodes.length > 0 ? (
          <button type="button" className="btn-primary" onClick={onStartReview}>
            Start review
          </button>
        ) : (
          <button type="button" className="btn-secondary" onClick={onOpenPractice}>
            Open Practice
          </button>
        )}
      </div>
      <div className="op-statline">
        <div className="op-stat">
          <span className="op-stat-label">Due now</span>
          <span className={`op-stat-num${dueNodes.length ? ' bad' : ''}`}>{dueNodes.length}</span>
        </div>
        <div className="op-stat">
          <span className="op-stat-label">Trained</span>
          <span className="op-stat-num">{trainedBranches.length}</span>
        </div>
        <div className="op-stat">
          <span className="op-stat-label">Saved</span>
          <span className="op-stat-num">{branches.length}</span>
        </div>
      </div>
      {dueNodes.length > 0 && (
        <div className="item-list review-due-list">
          {duePreview.map(node => {
            const duePath = node.path_san.split(' ').filter(Boolean)
            const prior = duePath.slice(0, -1)
            return (
              <button
                key={node.id}
                type="button"
                className="item-row due"
                onClick={() => {
                  onClearReview()
                  onJumpToPath(duePath)
                  onSetActiveTab('Repertoire')
                }}
                title="Open this position in Repertoire"
              >
                <span className="item-detail">{formatMoveLine(prior, 10) || 'Starting position'}</span>
                <span className="item-move">{node.san}</span>
                {node.drill_missed ? (
                  <span className="item-meta miss">{node.drill_missed} miss{node.drill_missed > 1 ? 'es' : ''}</span>
                ) : <span className="item-meta">due</span>}
              </button>
            )
          })}
        </div>
      )}
      {!dueNodes.length && (
        <div className="op-empty compact">
          <strong>Review queue is clear</strong>
          <p>Drill saved lines in Practice. Missed moves will appear here on schedule.</p>
        </div>
      )}
    </div>
  )
}
