import { useCallback, useEffect, useRef } from 'react'
import { Chessground } from 'chessground'
import 'chessground/assets/chessground.base.css'
import BoardCoordinates, { BoardFileStrip } from '../BoardCoordinates'
import PromotionDialog from '../PromotionDialog'
import './board.css'

const EMPTY_DESTS = new Map()

/**
 * Chessground board for the openings app.
 *
 * Click (or tap) a piece to see its legal destinations, then click a square to
 * move. Dragging works too. Arrow keys / navigation are handled by the parent.
 *
 * The board is created once and then reconciled through three focused effects:
 *   1. position  — `fen` + `lastMove`, only when they actually change.
 *   2. interaction — orientation, movable colour/dests, view-only state.
 *   3. shapes    — engine/explorer arrows, via the lightweight `setAutoShapes`.
 *
 * Splitting these matters: the engine eval and Lichess cloud arrive
 * asynchronously and update `shapes` several times per position. Routing those
 * through `setAutoShapes` (a pure SVG redraw) instead of a full `set({fen})`
 * means a late-arriving eval can never re-read the pieces mid-drag and cancel
 * the move the user is making.
 */
export default function Board({
  boardSize = 560,
  fen,
  orientation = 'white',
  lastMove = null,
  shapes = [],
  duration = 150,
  movableDests = null,
  movableColor = 'both',
  onMove = null,
  disabled = false,
  promotion = null,
  onPromotionSelect = null,
  onPromotionCancel = null,
  layoutKey = null,
  resetKey = 0,
}) {
  const elRef = useRef(null)
  const cgRef = useRef(null)
  const onMoveRef = useRef(onMove)
  const prevFenRef = useRef(fen)
  const prevLastMoveRef = useRef(lastMove)
  const prevResetKeyRef = useRef(resetKey)

  useEffect(() => {
    onMoveRef.current = onMove
  }, [onMove])

  // Stable handler: chessground keeps the same `events.after` reference for the
  // life of the board and we forward to the latest `onMove` through the ref.
  const handleCgMove = useCallback((orig, dest) => {
    onMoveRef.current?.(orig, dest)
  }, [])

  const canInteract = Boolean(onMove)
  const interactive = canInteract && !disabled
  // Chessground only flips `turnColor` when a move is made on the board — a bare
  // `set({ fen })` (move list, breadcrumbs, keyboard nav) leaves it stale, which
  // desyncs it from `movable.color` and freezes every piece. Derive it from the
  // FEN and set it explicitly on every position change so that never happens.
  const turnColor = fen?.split(' ')[1] === 'b' ? 'black' : 'white'

  // ── 1. Create the board once ──────────────────────────────────────────────
  useEffect(() => {
    cgRef.current = Chessground(elRef.current, {
      fen,
      orientation,
      turnColor,
      // Bind the pointer listeners now (events.js only checks viewOnly at bind
      // time). Interactivity is toggled afterwards through the `manipulable`
      // class that `set({ viewOnly })` flips.
      viewOnly: !canInteract,
      coordinates: false,
      animation: { enabled: true, duration },
      highlight: { lastMove: true, check: true },
      lastMove: lastMove || undefined,
      drawable: { enabled: false, visible: true, autoShapes: shapes },
      selectable: { enabled: true },
      draggable: {
        enabled: true,
        distance: 3,
        showGhost: true,
        autoDistance: true,
      },
      premovable: { enabled: false },
      movable: {
        free: false,
        color: movableColor,
        dests: movableDests || EMPTY_DESTS,
        showDests: interactive,
        events: { after: handleCgMove },
      },
    })
    prevFenRef.current = fen
    prevLastMoveRef.current = lastMove
    return () => {
      cgRef.current?.destroy()
      cgRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 2. Position: fen + lastMove (guarded so it never fires redundantly) ────
  useEffect(() => {
    const cg = cgRef.current
    if (!cg) return
    if (fen === prevFenRef.current && lastMove === prevLastMoveRef.current) return
    cg.set({ fen, turnColor, lastMove: lastMove || undefined })
    prevFenRef.current = fen
    prevLastMoveRef.current = lastMove
  }, [fen, turnColor, lastMove])

  // Re-apply the current FEN when the parent rejects a legal-looking move.
  // Chessground has already moved the piece internally by the time `after`
  // fires; if React state intentionally stays on the same FEN, the normal
  // guarded position effect has no prop change to observe.
  useEffect(() => {
    const cg = cgRef.current
    if (!cg || resetKey === prevResetKeyRef.current) return
    cg.set({ fen, turnColor, lastMove: lastMove || undefined })
    prevFenRef.current = fen
    prevLastMoveRef.current = lastMove
    prevResetKeyRef.current = resetKey
  }, [resetKey, fen, turnColor, lastMove])

  // ── 3. Interaction: orientation, movability, view-only freeze ──────────────
  useEffect(() => {
    const cg = cgRef.current
    if (!cg) return
    cg.set({
      orientation,
      viewOnly: !interactive,
      movable: {
        free: false,
        color: movableColor,
        dests: interactive ? (movableDests || EMPTY_DESTS) : EMPTY_DESTS,
        showDests: interactive,
        events: { after: handleCgMove },
      },
    })
  }, [orientation, movableColor, movableDests, interactive, handleCgMove])

  // ── 4. Arrows: pure redraw, never touches pieces or the user's selection ───
  useEffect(() => {
    cgRef.current?.setAutoShapes(shapes || [])
  }, [shapes])

  // ── 5. Re-measure bounds when the board moves without resizing ─────────────
  // Chessground memoises the board's bounding rect for pointer→square mapping
  // and only refreshes it on scroll, window resize, or a *size* change (its own
  // ResizeObserver). Entering a drill hides the engine rail, which shifts the
  // board sideways with no size change — none of those fire, so clicks would map
  // to the wrong square (offset by the rail's width). redrawAll() rebuilds the
  // bounds memo. rAF lets the new layout settle before we measure.
  useEffect(() => {
    const cg = cgRef.current
    if (!cg) return undefined
    const raf = requestAnimationFrame(() => cgRef.current?.redrawAll())
    return () => cancelAnimationFrame(raf)
  }, [layoutKey])

  return (
    <div className="board-area">
      <div className="board-frame">
        <div
          className="board-wrapper cr-board-inner-host"
          style={{ width: boardSize, height: boardSize }}
        >
          <div className="board-layer-pieces">
            <div className="cr-board-inner" ref={elRef} />
          </div>
          <BoardCoordinates boardSize={boardSize} orientation={orientation} />
          {promotion && (
            <PromotionDialog
              color={promotion.color}
              onSelect={onPromotionSelect}
              onCancel={onPromotionCancel}
            />
          )}
        </div>
        <BoardFileStrip boardSize={boardSize} orientation={orientation} />
      </div>
    </div>
  )
}
