import { useEffect, useRef, useState } from 'react'

/* Board sizing for the left-rail | board | right-panel shell.
 *
 * The square is derived from the *measured* `.op-shell` box plus the viewport, not from
 * raw `window.innerWidth/innerHeight` magic offsets. The old viewport-based formula made
 * the board jump whenever the viewport changed for reasons unrelated to the board — a
 * scrollbar appearing/disappearing, or the toolbar wrapping to a second row.
 *
 *   - width:  the shell's measured width minus the fixed siblings (rail + gaps + panel).
 *             The shell width is fixed by its parent, never by the board, so no feedback.
 *   - height: the viewport height measured *at the shell's top edge*. We deliberately do
 *             NOT use the shell's own height: the board lives inside the shell, so sizing
 *             from shell height would feed back on itself and collapse the board to its
 *             minimum. The shell's top moves only when the toolbar height changes, so this
 *             still absorbs a wrapped toolbar.
 */

const MIN = 280
const MAX = 680
const GAP = 16        // .op-shell column gap
const RAIL = 300      // .op-analysis-rail fixed width
const PANEL_MIN = 360 // .op-panel flex-basis / comfortable minimum
const BOTTOM = 24     // breathing room below the board column (crumbs sit under the board)

function snap(raw) {
  // Snap to a multiple of 8 (one chessground square = size/8): keeps squares on whole
  // pixels and stops sub-8px deltas from re-triggering a resize.
  return Math.floor(Math.min(Math.max(raw, MIN), MAX) / 8) * 8
}

function computeFromShell(el, hasRail) {
  const rect = el.getBoundingClientRect()
  const reservedW = (hasRail ? RAIL + GAP : 0) + GAP + PANEL_MIN
  const byWidth = rect.width - reservedW
  const byHeight = window.innerHeight - rect.top - BOTTOM
  return snap(Math.min(byWidth, byHeight))
}

/** First-paint estimate from the viewport, refined the instant the shell is measured. */
function guess() {
  if (typeof window === 'undefined') return MAX
  const byHeight = window.innerHeight - 180
  const vw = window.innerWidth
  const byWidth = vw > 1180 ? vw - 760 : vw > 820 ? vw - 380 : vw - 40
  return snap(Math.min(byHeight, byWidth))
}

export function useBoardSize(shellRef, hasRail = true) {
  const [size, setSize] = useState(guess)
  const raf = useRef(null)
  const hasRailRef = useRef(hasRail)
  useEffect(() => { hasRailRef.current = hasRail }, [hasRail])

  useEffect(() => {
    const el = shellRef?.current
    if (!el) return undefined
    const measure = () => {
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = requestAnimationFrame(() => setSize(computeFromShell(el, hasRailRef.current)))
    }
    measure()
    // ResizeObserver catches shell-width changes (window resize, rail show/hide); the
    // window listener catches viewport-height changes that don't alter the shell's box.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
      if (raf.current) cancelAnimationFrame(raf.current)
    }
  }, [shellRef])

  // Recompute immediately when the rail is shown/hidden (entering/leaving a drill).
  useEffect(() => {
    const el = shellRef?.current
    if (el) setSize(computeFromShell(el, hasRail))
  }, [hasRail, shellRef])

  return size
}
