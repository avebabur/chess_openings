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
 *   - height: the viewport height measured *at the shell's top edge*, minus the board
 *             column's own chrome. We deliberately do NOT use the shell's own height: the
 *             board lives inside the shell, so sizing from shell height would feed back on
 *             itself and collapse the board to its minimum. The shell's top moves only when
 *             the toolbar height changes, so this still absorbs a wrapped toolbar.
 *
 * "Chrome" is everything in `.op-board-column` that isn't the square: the board frame's
 * border and the move-crumbs nav below it. It is *measured* rather than hard-coded, because
 * a hard-coded reserve silently drifts from the CSS — the previous constant reserved 24px
 * for a ~80px stack, so on desktop (where `.openings-app` is `height:100vh; overflow:hidden`)
 * the crumbs bar was quietly cut off the bottom of the screen. Chrome height doesn't vary
 * with the board size, so feeding the measurement back in converges in a single pass, and
 * snap()'s multiple-of-8 rounding absorbs any sub-pixel jitter.
 */

const MIN = 280
const MAX = 680
const GAP = 16        // .op-shell column gap
const RAIL = 300      // .op-analysis-rail fixed width
const PANEL_MIN = 360 // .op-panel flex-basis / comfortable minimum
const BOTTOM = 16     // breathing room below the board column
const CHROME_GUESS = 80 // board border + crumbs, until the column has been measured once

function snap(raw) {
  // Snap to a multiple of 8 (one chessground square = size/8): keeps squares on whole
  // pixels and stops sub-8px deltas from re-triggering a resize.
  return Math.floor(Math.min(Math.max(raw, MIN), MAX) / 8) * 8
}

function computeFromShell(shellEl, columnEl, size) {
  const rect = shellEl.getBoundingClientRect()
  // Below the responsive breakpoint the shell wraps and the board gets the full width,
  // so the rail and panel no longer take any of it. Read that from the shell's own
  // computed flex-wrap rather than repeating the breakpoint here — the media query in
  // openings.css stays the single source of truth.
  const stacked = getComputedStyle(shellEl).flexWrap === 'wrap'
  const reservedW = stacked ? 0 : RAIL + GAP + GAP + PANEL_MIN
  const byWidth = rect.width - reservedW
  const chrome = columnEl
    ? Math.max(0, columnEl.getBoundingClientRect().height - size)
    : CHROME_GUESS
  // The shell's top in *document* coordinates. rect.top alone is relative to the
  // viewport, so on the stacked (scrolling) layout the board grew whenever a
  // resize landed mid-scroll — which mobile browsers fire as the address bar
  // collapses — and overflowed the screen (464px fresh, 680px after a scroll).
  const top = rect.top + window.scrollY
  const byHeight = window.innerHeight - top - chrome - BOTTOM
  return snap(Math.min(byWidth, byHeight))
}

/** First-paint estimate from the viewport, refined the instant the shell is measured. */
function guess() {
  if (typeof window === 'undefined') return MAX
  const byHeight = window.innerHeight - 180 - CHROME_GUESS
  const vw = window.innerWidth
  const byWidth = vw > 1180 ? vw - 760 : vw > 820 ? vw - 380 : vw - 40
  return snap(Math.min(byHeight, byWidth))
}

export function useBoardSize(shellRef, columnRef) {
  const [size, setSize] = useState(guess)
  const raf = useRef(null)
  // The measurement needs the *current* size to subtract it out, but re-running the effect
  // on every size change would tear down the observers each time. A ref keeps the callback
  // stable while still reading a fresh value.
  const sizeRef = useRef(size)
  useEffect(() => { sizeRef.current = size }, [size])

  useEffect(() => {
    const el = shellRef?.current
    if (!el) return undefined
    const measure = () => {
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = requestAnimationFrame(() => {
        setSize(computeFromShell(el, columnRef?.current, sizeRef.current))
      })
    }
    measure()
    // ResizeObserver catches shell-width changes (window resize) and board-column height
    // changes (the crumbs bar wrapping); the window listener catches viewport-height
    // changes that don't alter either box.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    if (columnRef?.current) ro?.observe(columnRef.current)
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
      if (raf.current) cancelAnimationFrame(raf.current)
    }
  }, [shellRef, columnRef])

  return size
}
