import { useRef, useEffect } from 'react'
import { START_FEN } from '../domain/chessLine'
import Board from './Board/Chessground'

export default function BoardPane({
  boardSize,
  inSession,
  display,
  displayPath,
  path,
  orientation,
  shapes,
  movableDests,
  movableColor,
  boardOnMove,
  pendingPromotion,
  onPromotionSelect,
  onPromotionCancel,
  boardResetKey,
  isTraining,
  trainerStrip,
  isReviewing,
  review,
  reviewItem,
  reviewCompleted,
  onExitSession,
  onGoStart,
  onGoBack,
  canGoForward,
  onGoForward,
  onFlip,
  onCrumbClick,
}) {
  const crumbsScrollRef = useRef(null)

  const crumbsScrollKey = displayPath.join(' ')

  useEffect(() => {
    const el = crumbsScrollRef.current
    if (!el) return
    el.scrollLeft = el.scrollWidth
  }, [displayPath.length, crumbsScrollKey])

  return (
    <section
      className="op-board-column"
      aria-label="Board"
      style={{ '--board-col-w': `${boardSize + 8}px` }}
    >
      <Board
        boardSize={boardSize}
        layoutKey={inSession ? 'session' : 'browse'}
        fen={display.fen || START_FEN}
        orientation={orientation}
        lastMove={display.last}
        shapes={shapes}
        movableDests={movableDests}
        movableColor={movableColor}
        onMove={boardOnMove}
        disabled={Boolean(pendingPromotion)}
        promotion={pendingPromotion}
        onPromotionSelect={onPromotionSelect}
        onPromotionCancel={onPromotionCancel}
        resetKey={boardResetKey}
      />

      <nav className="op-crumbs" aria-label="Move history">
        <button
          type="button"
          className="crumb crumb-home"
          onClick={() => { if (inSession) onExitSession(); else onGoStart() }}
          disabled={!displayPath.length && !inSession}
          title="Return to start (↑ / Home)"
        >
          ⟲
        </button>
        <div className="op-crumbs-scroll" ref={crumbsScrollRef}>
          {displayPath.map((san, i) => (
            <button
              key={`${i}-${san}`}
              type="button"
              className={`crumb${!inSession && i === path.length - 1 ? ' current' : ''}`}
              onClick={() => !inSession && onCrumbClick(i)}
              disabled={inSession}
            >
              {i % 2 === 0 ? `${Math.floor(i / 2) + 1}.` : ''}{san}
            </button>
          ))}
        </div>
        <div className="op-crumbs-tail">
          {!inSession && (
            <>
              <button
                type="button"
                className="crumb crumb-nav"
                onClick={onGoBack}
                disabled={!path.length}
                title="Back (←)"
                aria-label="Back one move"
              >
                ←
              </button>
              <button
                type="button"
                className="crumb crumb-nav"
                onClick={onGoForward}
                disabled={!canGoForward}
                title="Forward (→)"
                aria-label="Forward one move"
              >
                →
              </button>
            </>
          )}
          <button
            type="button"
            className="crumb crumb-nav"
            onClick={onFlip}
            title="Flip board (F)"
            aria-label="Flip board"
          >
            ⇅
          </button>
        </div>
      </nav>

      {isTraining && trainerStrip && (
        <div className="op-practice-strip">
          <div className="op-practice-strip-head">
            <span>Drilling: {trainerStrip.label}</span>
            <span>{trainerStrip.done}/{trainerStrip.total} lines</span>
          </div>
          <div className="op-practice-progress">
            <div className="op-practice-progress-fill" style={{ width: `${trainerStrip.progress}%` }} />
          </div>
        </div>
      )}

      {isReviewing && (
        <div className="op-practice-strip review">
          <div className="op-practice-strip-head">
            <span>Reviewing · find the move for {reviewItem.color === 'white' ? 'White' : 'Black'}</span>
            <span>{review.idx + 1}/{review.queue.length}</span>
          </div>
          <div className="op-practice-progress">
            <div
              className="op-practice-progress-fill"
              style={{ width: `${Math.round((reviewCompleted / review.queue.length) * 100)}%` }}
            />
          </div>
        </div>
      )}
    </section>
  )
}
