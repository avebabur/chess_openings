import { useCallback, useEffect, useRef } from 'react'
import { Chessground } from '@lichess-org/chessground'
import '@lichess-org/chessground/assets/chessground.base.css'
import PromotionDialog from '../PromotionDialog'
import './board.css'

const EMPTY_DESTS = new Map()

// Lichess's "Normal" preference is 250ms (Pref.scala animationMillis:
// 0/120/250/500), but that is not what its boards run at. The server scales it
// by the game's clock (modules/round JsonView.animationMillis): 0 for bullet,
// rising to a cap of 1.2x for games of seven minutes or more, and for anything
// with no clock at all, which is the analysis board. So the lichess you see
// while analysing or playing rapid glides for 300ms. Measured on lichess.org's
// analysis board: 300ms, 19 frames.
// Anything under 70ms makes chessground disable animation outright, which is how
// the reduced-motion path below switches it off.
const ANIM_MS = 300

const prefersReducedMotion = () => (
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches
)

// Safari drops the hover state on a square while a piece is being dragged over
// it; chessground has a JS-driven fallback for exactly this, which lichess turns
// on for Safari only (ui/analyse/src/ground.ts).
const isSafari = () => (
  typeof navigator !== 'undefined'
  && /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
)

/**
 * Chessground board for the openings app.
 *
 * Click (or tap) a piece to see its legal destinations, then click a square to
 * move. Dragging works too. Arrow keys / navigation are handled by the parent.
 *
 * The configuration follows lichess's own (ui/analyse/src/ground.ts and
 * ui/round/src/ground.ts), on the same @lichess-org/chessground build:
 *   - Right-drag draws an arrow, right-click circles a square. Shift/Ctrl makes
 *     it red, Alt blue, both yellow. A left click on the board clears them, and
 *     so does any position change.
 *   - With `premove`, the side in `movableColor` can queue one move while it is
 *     the other side's turn. It is played the moment the turn comes back, if it
 *     is still legal, and dropped otherwise. Only meaningful when one colour is
 *     the player's (a drill, a game against the engine), never with 'both'.
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
  check = false,
  shapes = [],
  duration = ANIM_MS,
  movableDests = null,
  movableColor = 'both',
  premove = false,
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
  const prevOrientationRef = useRef(orientation)
  const prevAnimRef = useRef(null)
  // Set whenever chessground rebuilt its DOM while frozen. redrawAll() rebinds
  // the pointer listeners through events.bindBoard, which early-returns on
  // viewOnly — so a rebuild during a promotion dialog leaves the board dead and
  // nothing rebinds it later. We remember and rebind once it is live again.
  const needsRebindRef = useRef(false)

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
  const animMs = prefersReducedMotion() ? 0 : duration

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
      coordinates: true,
      // Publishes ---cg-width / ---cg-height, so anything that wants to match
      // the board's exact pixel height (the eval bar) can read them.
      addDimensionsCssVarsTo: document.body,
      // Without this chessground never calls preventDefault on contextmenu (it
      // only does so for disableContextMenu or an enabled drawable), so
      // right-clicking the board popped the native browser menu.
      disableContextMenu: true,
      jsHover: isSafari(),
      animation: { enabled: true, duration: animMs },
      highlight: { lastMove: true, check: true },
      lastMove: lastMove || undefined,
      check,
      drawable: {
        enabled: true,
        visible: true,
        defaultSnapToValidMove: true,
        eraseOnMovablePieceClick: true,
        autoShapes: shapes,
      },
      selectable: { enabled: true },
      draggable: {
        enabled: true,
        distance: 3,
        showGhost: true,
        autoDistance: true,
      },
      premovable: { enabled: premove, showDests: true, castle: true },
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
    prevAnimRef.current = animMs
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
    // `check` must be passed on every position change, not only when true:
    // configure() reads it as `config.check || false`, so omitting the key
    // leaves the previous king square lit.
    cg.set({ fen, turnColor, lastMove: lastMove || undefined, check })
    prevFenRef.current = fen
    prevLastMoveRef.current = lastMove
  }, [fen, turnColor, lastMove, check])

  // Re-apply the current FEN when the parent rejects a legal-looking move.
  // Chessground has already moved the piece internally by the time `after`
  // fires; if React state intentionally stays on the same FEN, the normal
  // guarded position effect has no prop change to observe.
  useEffect(() => {
    const cg = cgRef.current
    if (!cg || resetKey === prevResetKeyRef.current) return
    // A rejected move also voids whatever was queued behind it.
    cg.cancelPremove()
    cg.set({ fen, turnColor, lastMove: lastMove || undefined, check })
    prevFenRef.current = fen
    prevLastMoveRef.current = lastMove
    prevResetKeyRef.current = resetKey
  }, [resetKey, fen, turnColor, lastMove, check])

  // ── 3. Interaction: orientation, movability, view-only freeze ──────────────
  useEffect(() => {
    const cg = cgRef.current
    if (!cg) return
    // viewOnly first, orientation second, deliberately. api.set() runs
    // toggleOrientation() *before* configure() applies the rest of the config,
    // and toggleOrientation wipes and rebuilds the board DOM. Clearing viewOnly
    // in its own call means that rebuild happens on an already-live board.
    cg.set({
      viewOnly: !interactive,
      movable: {
        free: false,
        color: movableColor,
        dests: interactive ? (movableDests || EMPTY_DESTS) : EMPTY_DESTS,
        showDests: interactive,
        events: { after: handleCgMove },
      },
      premovable: { enabled: premove },
    })
    if (!premove) cg.cancelPremove()
    if (prevOrientationRef.current !== orientation) {
      prevOrientationRef.current = orientation
      cg.set({ orientation })
      if (!interactive) needsRebindRef.current = true
    }
    if (interactive && needsRebindRef.current) {
      needsRebindRef.current = false
      cg.redrawAll()
    }
  }, [orientation, movableColor, movableDests, premove, interactive, handleCgMove])

  // ── 3a. Play a queued premove once the turn is back ────────────────────────
  // Declared after the position and interaction effects on purpose: effects run
  // in order, so by now chessground holds the new pieces *and* the new legal
  // destinations. playPremove() checks the queued move against those and either
  // plays it (firing `movable.events.after` like a normal move) or drops it.
  const canPlayNow = premove && interactive && turnColor === movableColor
    && Boolean(movableDests && movableDests.size)
  useEffect(() => {
    if (canPlayNow) cgRef.current?.playPremove()
  }, [canPlayNow, fen])

  // ── 3b. Animation speed, if the OS motion preference changes mid-session ───
  useEffect(() => {
    // Skip the first run: creation already applied this duration.
    if (prevAnimRef.current === null || prevAnimRef.current === animMs) {
      prevAnimRef.current = animMs
      return
    }
    prevAnimRef.current = animMs
    cgRef.current?.set({ animation: { enabled: animMs >= 70, duration: animMs } })
  }, [animMs])

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
    const raf = requestAnimationFrame(() => {
      cgRef.current?.redrawAll()
      // Same trap as the flip above: this rebuild binds no pointer listeners
      // while the board is frozen, so remember to rebind when it wakes up.
      if (!interactive) needsRebindRef.current = true
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- layout moves only
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
          {promotion && (
            <PromotionDialog
              color={promotion.color}
              onSelect={onPromotionSelect}
              onCancel={onPromotionCancel}
            />
          )}
        </div>
      </div>
    </div>
  )
}
