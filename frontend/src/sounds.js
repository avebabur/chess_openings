/**
 * Board sounds, modelled on lichess's ui/site/src/sound.ts.
 *
 * WebAudio rather than <audio> elements: a decoded AudioBuffer replayed through
 * a fresh BufferSource has no start-up latency and overlaps cleanly, so fast
 * moves never clip each other or need a pool of elements to round-robin.
 *
 * The samples in public/sounds/lichess are lichess's own. Note what lichess
 * does *not* have: its standard theme symlinks Check.mp3 to Silence.mp3 and
 * Checkmate.mp3 to Check.mp3, so a checking move plays the ordinary move or
 * capture sound and nothing more. This used to play a chime on any `+`/`#`,
 * tested before the capture branch, so `Qxf7+` sounded like a confirmation
 * rather than a capture.
 */

const SOUND_BASE = '/sounds/lichess'
const SOUND_EXT = 'mp3' // native WebView does not reliably play .ogg
const VOLUME = 0.7 // lichess's default master volume
const BOARD_SOUNDS = ['Move', 'Capture', 'Error']

// lichess throttles at 100ms: hold an arrow key and you hear the moves go by,
// rather than silence followed by a single click when you stop.
const THROTTLE_MS = 100

let ctx = null
let master = null
const buffers = new Map() // name -> AudioBuffer
const pending = new Map() // name -> Promise<AudioBuffer | null>

function audioContext() {
  if (ctx) return ctx
  const Ctor = window.AudioContext || window.webkitAudioContext
  if (!Ctor) return null
  ctx = new Ctor({ latencyHint: 'interactive' })
  master = ctx.createGain()
  master.gain.value = VOLUME
  master.connect(ctx.destination)
  return ctx
}

function load(name) {
  if (buffers.has(name)) return Promise.resolve(buffers.get(name))
  const inFlight = pending.get(name)
  if (inFlight) return inFlight
  const context = audioContext()
  if (!context) return Promise.resolve(null)

  const task = fetch(`${SOUND_BASE}/${name}.${SOUND_EXT}`)
    .then(res => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(res.status))))
    .then(bytes => context.decodeAudioData(bytes))
    .then((buffer) => {
      buffers.set(name, buffer)
      pending.delete(name)
      return buffer
    })
    .catch(() => {
      pending.delete(name)
      return null
    })
  pending.set(name, task)
  return task
}

// Off the critical path, as lichess does (its constructor wraps the whole
// AudioContext setup in requestIdleCallback). Building the context is not free
// — it can block while the audio device spins up — and main.jsx calls this at
// module load, before React has mounted or bound a single listener.
const whenIdle = (fn) => {
  if (typeof window === 'undefined') return
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(fn, { timeout: 2000 })
  else setTimeout(fn, 0)
}

export function preloadSounds() {
  whenIdle(() => {
    for (const name of BOARD_SOUNDS) load(name)
  })
}

// Browsers start the context suspended until a real gesture. Resume on the
// first one, then stop listening — same event set lichess primes on.
const PRIMER_EVENTS = ['pointerdown', 'mousedown', 'touchend', 'keydown']

function unprime() {
  for (const type of PRIMER_EVENTS) {
    window.removeEventListener(type, prime, { capture: true })
  }
}

function prime() {
  const context = audioContext()
  if (!context) return unprime()
  if (context.state === 'suspended') context.resume().catch(() => {})
  for (const name of BOARD_SOUNDS) load(name)
  unprime()
}

if (typeof window !== 'undefined') {
  for (const type of PRIMER_EVENTS) {
    window.addEventListener(type, prime, { capture: true })
  }
}

function playNamed(name) {
  const context = audioContext()
  if (!context) return
  if (context.state === 'suspended') context.resume().catch(() => {})
  const buffer = buffers.get(name)
  if (!buffer) {
    // First use of a sound we have not decoded yet: fetch it, then play once.
    load(name).then((decoded) => {
      if (!decoded || !ctx) return
      const source = ctx.createBufferSource()
      source.buffer = decoded
      source.connect(master)
      source.start(0)
    })
    return
  }
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(master)
  source.start(0)
}

/** Capture or move — lichess plays nothing extra for check or mate. */
function playForSan(san) {
  playNamed(san.includes('x') ? 'Capture' : 'Move')
}

// -Infinity, not 0: the first move of a session must never wait out a
// throttle window it was never part of.
let lastPlayedAt = -Infinity
let trailingTimer = null
let trailingSan = null

/**
 * One sound per move, throttled so scrubbing through a long line stays audible
 * without machine-gunning. The trailing call guarantees the move you actually
 * land on is heard even if it fell inside a throttle window.
 */
export function playStepSound(san) {
  if (!san) return
  const now = performance.now()
  const since = now - lastPlayedAt

  if (since >= THROTTLE_MS) {
    lastPlayedAt = now
    trailingSan = null
    if (trailingTimer) {
      clearTimeout(trailingTimer)
      trailingTimer = null
    }
    playForSan(san)
    return
  }

  trailingSan = san
  if (trailingTimer) return
  trailingTimer = setTimeout(() => {
    trailingTimer = null
    if (!trailingSan) return
    lastPlayedAt = performance.now()
    playForSan(trailingSan)
    trailingSan = null
  }, THROTTLE_MS - since)
}

export function playIllegalSound() {
  playNamed('Error')
}
