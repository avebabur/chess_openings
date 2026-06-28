import { useCallback, useEffect, useRef, useState } from 'react'
import { api, API } from '../api'

const DEBOUNCE_MS = 150
// Browsing analysis is time-based: the default search runs for DEFAULT_TIME seconds, and
// each "+" press steps to a longer budget; the last (Infinity) runs until stopped or the
// position changes. Time-based + multithreaded reaches a useful depth fast and keeps a
// predictable latency; the achieved depth is shown so you always know how far it got.
export const DEFAULT_TIME = 4                      // seconds
export const TIME_TIERS = [4, 10, 30, Infinity]    // seconds; Infinity = unbounded ∞
export const MIN_SAVE_DEPTH = 22                   // achieved depth required to save an eval
export const DEFAULT_TARGET = { secs: DEFAULT_TIME }

// A search target is either time-bounded `{ secs }` (secs may be Infinity for ∞) or, after
// a "freeze", depth-bounded `{ depth }` — a snapshot of the depth reached when the user
// stopped a long search, so the warm engine re-confirms it instantly and settles.

/** Step to the next (longer / deeper) tier. */
export function nextTier(target) {
  if (target.depth != null) return { secs: Infinity }     // frozen → deepen goes unbounded
  if (!Number.isFinite(target.secs)) return target         // already ∞
  const next = TIME_TIERS.find((t) => t > target.secs)
  return next == null ? target : { secs: next }
}

/** Step to the previous (shorter) tier. */
export function prevTier(target) {
  if (target.depth != null) return { secs: 30 }            // frozen → shallow to 30s
  let prev = target.secs
  for (const t of TIME_TIERS) {
    if (t < target.secs) prev = t
    else break
  }
  return { secs: prev }
}

export function targetIsInfinite(target) {
  return target?.secs === Infinity
}

export function targetIsDefault(target) {
  return target?.secs === DEFAULT_TIME
}

/** Anything past the default browse: a longer time budget, ∞, or a frozen deep snapshot. */
export function targetIsDeeper(target) {
  if (!target) return false
  return target.depth != null
    || target.secs === Infinity
    || (Number.isFinite(target.secs) && target.secs > DEFAULT_TIME)
}

export function canSavePositionEval(positionEval) {
  return Boolean(
    positionEval &&
    !positionEval.searching &&
    !positionEval.error &&
    positionEval.eval != null &&
    Number(positionEval.depth) >= MIN_SAVE_DEPTH
  )
}

/**
 * Live engine + Lichess-cloud eval for the current FEN.
 *
 * Stockfish streams depth-by-depth over SSE (read with fetch + a ReadableStream
 * so we can abort it), so lines appear as each depth completes and refine in
 * place. Navigating aborts the in-flight request — the backend cancels the old
 * search immediately — so analysis never queues up or sticks on "Searching…".
 *
 * Two extras layer on top of that:
 *  - `deepen`/`goInfinite` raise the time budget so the engine keeps calculating
 *    past the default 4s (deeper tiers run longer; Infinity is unbounded).
 *  - a user-saved deep eval for the position auto-loads as the engine line, so we
 *    skip re-searching it and never need to call Lichess cloud for it.
 */
export function usePositionEval(fen) {
  const [localEval, setLocalEval] = useState(null)
  const [cloud, setCloud] = useState(null)
  const [saved, setSaved] = useState(null)            // saved-eval record for this fen (or null)
  const [target, setTarget] = useState(DEFAULT_TARGET)
  const [reloadKey, setReloadKey] = useState(0)       // bump to force a fresh live search
  const [actionError, setActionError] = useState('')
  const [trackedFen, setTrackedFen] = useState(fen)
  // Latest FEN, read by the user-initiated cloud/save calls so a late reply after
  // navigation can be discarded instead of clobbering the new position.
  const fenRef = useRef(fen)
  useEffect(() => { fenRef.current = fen }, [fen])
  // Latest live eval, read by `freeze` so it can snapshot the current depth without
  // re-creating the callback (and re-subscribing the global key listener) every frame.
  const evalRef = useRef(localEval)
  useEffect(() => { evalRef.current = localEval }, [localEval])

  // Reset every panel the instant the position changes (React's render-phase
  // state-reset pattern): show "searching", drop the previous position's cloud /
  // saved line. The target tier is kept so deepening/shallowing persists as you click
  // through a line.
  if (fen !== trackedFen) {
    setTrackedFen(fen)
    setLocalEval(fen
      ? { fen, searching: true, depth: 0, lines: [] }
      : null)
    setCloud(null)
    setSaved(null)
    setActionError('')
  }

  useEffect(() => {
    if (!fen) return undefined
    const controller = new AbortController()
    const atDefault = targetIsDefault(target)
    const timer = setTimeout(() => {
      // Cache-only cloud read — never calls Lichess. A miss returns source:"unknown",
      // which the panel surfaces as a "Get cloud eval" button.
      fetchCloudEval(fen, false, controller.signal, setCloud)
      // At the default tier a saved deep eval wins: show it instantly and skip the
      // live search (and any need for cloud). Deepening always runs the live engine.
      if (atDefault) {
        loadSavedThenMaybeStream(fen, controller.signal, setSaved, setLocalEval)
      } else {
        streamLocalEval(fen, controller.signal, setLocalEval, target)
      }
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [fen, target, reloadKey])

  const deepen = useCallback(() => setTarget((t) => nextTier(t)), [])
  const shallow = useCallback(() => setTarget((t) => prevTier(t)), [])
  const goInfinite = useCallback(() => setTarget({ secs: Infinity }), [])
  const resetDepth = useCallback(() => setTarget(DEFAULT_TARGET), [])

  // Stop an infinite / long search by pinning the target to the depth reached now. The
  // effect re-runs with a depth cap, so the (hash-warm) engine re-confirms that depth
  // immediately and emits `done` — settling `searching:false` so the eval becomes
  // saveable. Below the save floor it pins to MIN_SAVE_DEPTH.
  const freeze = useCallback(() => {
    const cur = Math.floor(Number(evalRef.current?.depth) || 0)
    if (cur >= 1) setTarget({ depth: Math.max(cur, MIN_SAVE_DEPTH) })
  }, [])

  // Persist the current live eval for this position. Future visits auto-load it.
  const saveEval = useCallback(() => {
    const fenTarget = fenRef.current
    const ev = localEval
    if (!fenTarget || !canSavePositionEval(ev)) return
    const payload = {
      eval: ev.eval, depth: ev.depth, best_move: ev.best_move,
      best_move_uci: ev.best_move_uci, lines: ev.lines || [],
    }
    api.post('/saved-eval', { fen: fenTarget, payload })
      .then(() => {
        if (fenRef.current !== fenTarget) return
        setActionError('')
        setSaved({ payload, depth: payload.depth })
        setLocalEval((prev) => (prev && prev.fen === fenTarget
          ? { ...prev, saved: true, saved_depth: payload.depth, searching: false }
          : prev))
      })
      .catch(() => {
        if (fenRef.current === fenTarget) setActionError('Could not save this evaluation')
      })
  }, [localEval])

  // Drop the saved eval and fall back to a fresh live search.
  const clearSaved = useCallback(() => {
    const fenTarget = fenRef.current
    if (!fenTarget) return
    api.delete('/saved-eval', { params: { fen: fenTarget } })
      .then(() => {
        if (fenRef.current !== fenTarget) return
        setActionError('')
        setSaved(null)
        setTarget(DEFAULT_TARGET)
        setReloadKey((k) => k + 1)   // re-run the effect even if already at default
      })
      .catch(() => {
        if (fenRef.current === fenTarget) setActionError('Could not clear the saved evaluation')
      })
  }, [])

  // User-initiated: hit Lichess once for the current position and cache it forever.
  // Not abortable on navigation — let it finish and populate the cache; we just drop
  // the UI update if the position has moved on.
  const fetchCloud = useCallback(() => {
    const fenTarget = fenRef.current
    if (!fenTarget) return
    setCloud({ source: 'fetching', fen: fenTarget })
    fetchCloudEval(fenTarget, true, null, (data) => {
      if (fenRef.current === fenTarget) setCloud(data)
    })
  }, [])

  return {
    localEval, cloud, saved, target, actionError,
    fetchCloud, deepen, shallow, goInfinite, resetDepth, freeze, saveEval, clearSaved,
  }
}

/** Map a search target to the engine's depth/time caps for the eval-stream request. */
function targetParams(target) {
  if (target?.depth != null) return { depth: target.depth, maxSeconds: 0 }   // frozen
  return { depth: 0, maxSeconds: Number.isFinite(target?.secs) ? target.secs : 0 }
}

async function loadSavedThenMaybeStream(fen, signal, setSaved, setLocalEval) {
  let record
  try {
    const res = await api.get('/saved-eval', { params: { fen }, signal })
    record = res.data
  } catch {
    record = null
  }
  if (signal.aborted) return
  const savedDepth = Number(record?.depth ?? record?.payload?.depth)
  if (record?.payload && savedDepth >= MIN_SAVE_DEPTH) {
    const p = record.payload
    setSaved(record)
    setLocalEval({
      fen,
      searching: false,
      saved: true,
      saved_depth: record.depth ?? p.depth,
      depth: p.depth,
      eval: p.eval,
      best_move: p.best_move,
      best_move_uci: p.best_move_uci,
      lines: p.lines || [],
    })
  } else {
    setSaved(null)
    streamLocalEval(fen, signal, setLocalEval, DEFAULT_TARGET)
  }
}

function parseSseData(frame) {
  const line = frame.split('\n').find((l) => l.startsWith('data:'))
  if (!line) return null
  try {
    return JSON.parse(line.slice(5).trim())
  } catch {
    return null
  }
}

async function streamLocalEval(fen, signal, setLocalEval, target = DEFAULT_TARGET) {
  const { depth, maxSeconds } = targetParams(target)
  const url = `${API}/evaluate-stream?fen=${encodeURIComponent(fen)}`
    + `&depth=${depth}&max_seconds=${maxSeconds}`
  try {
    const res = await fetch(url, { signal })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        if (signal.aborted) return
        const data = parseSseData(buffer.slice(0, sep))
        buffer = buffer.slice(sep + 2)
        if (!data) continue
        if (data.error) {
          setLocalEval((prev) => ({ ...(prev || {}), fen, error: true, searching: false }))
          return
        }
        setLocalEval({
          ...data,
          fen,
          searching: !data.done,
        })
        if (data.done) return
      }
    }
    // Stream ended without an explicit done frame — clear the spinner.
    if (!signal.aborted) {
      setLocalEval((prev) => (prev && prev.fen === fen ? { ...prev, searching: false } : prev))
    }
  } catch {
    if (!signal.aborted) {
      setLocalEval((prev) => ({ ...(prev || {}), fen, error: true, searching: false }))
    }
  }
}

/**
 * Fetch the Lichess cloud eval. `network=false` is a cache-only read (the
 * backend never calls Lichess); `network=true` fetches once and caches forever.
 * `signal` may be null for user-initiated fetches that should outlive navigation.
 */
async function fetchCloudEval(fen, network, signal, setCloud) {
  try {
    const res = await api.get('/cloud-eval', {
      params: { fen, multipv: 3, network }, signal,
    })
    if (!signal?.aborted) setCloud(res.data)
  } catch {
    if (!signal?.aborted) setCloud({ source: 'error' })
  }
}
