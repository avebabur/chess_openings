const SOUND_BASE = '/sounds/lichess'
const SOUND_EXT = 'mp3' // native WebView does not reliably play .ogg
const POOL_SIZE = 4

const pools = new Map()

function getPool(name) {
  if (!pools.has(name)) {
    const els = []
    for (let i = 0; i < POOL_SIZE; i++) {
      const a = new Audio(`${SOUND_BASE}/${name}.${SOUND_EXT}`)
      a.preload = 'auto'
      els.push(a)
    }
    pools.set(name, { els, idx: 0 })
  }
  return pools.get(name)
}

export function preloadSounds() {
  for (const n of ['Move', 'Capture', 'Confirmation', 'Error']) {
    getPool(n)
  }
}

function playNamed(name) {
  const pool = getPool(name)
  const a = pool.els[pool.idx]
  pool.idx = (pool.idx + 1) % POOL_SIZE
  a.currentTime = 0
  a.play().catch(() => {})
}

function playForSan(san) {
  if (/[+#]/.test(san)) playNamed('Confirmation')
  else if (san.includes('x')) playNamed('Capture')
  else if (san === 'O-O' || san === 'O-O-O') playNamed('Move')
  else if (san.includes('=')) playNamed('Confirmation')
  else playNamed('Move')
}

let lastStepAt = 0
let debounceTimer = null
let pendingSan = null

const RAPID_GAP_MS = 180
const DEBOUNCE_MS = 120

/** Lichess sounds; debounced during fast arrow-key scrubbing (chess.com-style). */
export function playStepSound(san) {
  if (!san) return

  const now = performance.now()
  const rapid = now - lastStepAt < RAPID_GAP_MS
  lastStepAt = now
  pendingSan = san

  if (debounceTimer) clearTimeout(debounceTimer)

  const flush = () => {
    debounceTimer = null
    if (pendingSan) playForSan(pendingSan)
    pendingSan = null
  }

  if (rapid) {
    debounceTimer = setTimeout(flush, DEBOUNCE_MS)
  } else {
    playForSan(san)
    pendingSan = null
  }
}

export function playIllegalSound() {
  playNamed('Error')
}

document.addEventListener('click', preloadSounds, { once: true })
document.addEventListener('keydown', preloadSounds, { once: true })
