import { useRef, useEffect, useMemo } from 'react'
import { START_FEN, isCheckFen } from '../domain/chessLine'
import Board from './Board/Chessground'

// "12." before a White move; "12…" before a Black move that opens the list
// (a game started from a position where Black is to move).
function moveNumberPrefix(ply, first) {
  const number = Math.floor(ply / 2) + 1
  if (ply % 2 === 0) return `${number}.`
  return first ? `${number}…` : ''
}

export default function BoardPane({
  boardSize,
  columnRef,
  inSession,
  display,
  displayPath,
  startPly = 0,
  path,
  orientation,
  shapes,
  movableDests,
  movableColor,
  premove,
  boardOnMove,
  pendingPromotion,
  onPromotionSelect,
  onPromotionCancel,
  boardResetKey,
  onExitSession,
  onGoStart,
  onGoBack,
  canGoForward,
  onGoForward,
  onFlip,
  onCrumbClick,
}) {
  const crumbsScrollRef = useRef(null)
  const boardFen = display.fen || START_FEN
  const inCheck = useMemo(() => isCheckFen(boardFen), [boardFen])

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
      ref={columnRef}
      style={{ '--board-col-w': `${boardSize + 8}px` }}
    >
      <Board
        boardSize={boardSize}
        layoutKey={inSession ? 'session' : 'browse'}
        fen={boardFen}
        orientation={orientation}
        lastMove={display.last}
        check={inCheck}
        shapes={shapes}
        movableDests={movableDests}
        movableColor={movableColor}
        premove={premove}
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
          aria-label={inSession ? 'Exit session' : 'Return to start'}
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
              {moveNumberPrefix(startPly + i, i === 0)}{san}
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
            disabled={Boolean(pendingPromotion)}
            title="Flip board (F)"
            aria-label="Flip board"
          >
            ⇅
          </button>
        </div>
      </nav>
    </section>
  )
}
