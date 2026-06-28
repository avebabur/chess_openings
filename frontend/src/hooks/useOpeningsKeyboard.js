import { useEffect } from 'react'

/**
 * Global keyboard navigation for the Openings explorer — the same muscle memory
 * as Game Review, adapted to the explore/repertoire line.
 *
 * Bindings (ignored while focus is in an INPUT/TEXTAREA/contentEditable):
 *   ← / →        step back / forward one move along the current line
 *   ↑ / Home     jump to the starting position
 *   ↓ / End      jump to the end of the explored line
 *   f            flip the board
 *   = / +        deepen Stockfish search (next depth tier)
 *   -            shallow Stockfish search (previous depth tier)
 *   0            stop/freeze at the current depth (lets it finish, then it's saveable)
 *   Esc          dismiss a pending promotion
 *
 * Modifier combos (Cmd/Ctrl/Alt) are ignored so the browser's own shortcuts —
 * find (⌘F), zoom (⌘=/⌘-), reload, etc. — keep working. Shift is allowed because
 * `+`/`_` are shifted `=`/`-`.
 *
 * Stepping forward (→) replays moves you stepped back over — the parent keeps a
 * small redo stack so the line is never lost. While a promotion picker is open
 * only Esc is honoured, so a stray arrow tap can't change the position behind
 * the modal.
 */
export function useOpeningsKeyboard({
  enabled = true,
  engineEnabled = false,
  pendingPromotion,
  cancelPromotion,
  goBack,
  goForward,
  goStart,
  goEnd,
  flip,
  deepen,
  shallow,
  freeze,
}) {
  useEffect(() => {
    const handleKey = (e) => {
      // Leave modifier combos to the browser (⌘F find, ⌘=/⌘- zoom, ⌘R reload, …).
      // Shift is fine: `+`/`_` are shifted `=`/`-`.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      ) {
        return
      }

      // While promoting, swallow navigation; only allow cancelling.
      if (pendingPromotion) {
        if (e.key === 'Escape') {
          e.preventDefault()
          cancelPromotion?.()
        }
        return
      }

      // `f` flips even when line navigation is disabled (e.g. during practice).
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        flip?.()
        return
      }

      // Engine depth: =/+ deepen, - shallow (only when the analysis rail is visible).
      if (engineEnabled) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault()
          deepen?.()
          return
        }
        if (e.key === '-' || e.key === '_') {
          e.preventDefault()
          shallow?.()
          return
        }
        if (e.key === '0') {
          e.preventDefault()
          freeze?.()
          return
        }
      }

      if (!enabled) return

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault()
          goBack?.()
          break
        case 'ArrowRight':
          e.preventDefault()
          goForward?.()
          break
        case 'ArrowUp':
        case 'Home':
          e.preventDefault()
          goStart?.()
          break
        case 'ArrowDown':
        case 'End':
          e.preventDefault()
          goEnd?.()
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [enabled, engineEnabled, pendingPromotion, cancelPromotion, goBack, goForward, goStart, goEnd, flip, deepen, shallow, freeze])
}
