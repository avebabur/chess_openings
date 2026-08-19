import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Minimal WebAudio stand-in: records which buffer each BufferSource played.
function stubAudio() {
  const started = []
  const decoded = new Map()
  class FakeContext {
    constructor() {
      this.state = 'running'
      this.destination = {}
    }

    createGain() {
      return { gain: { value: 1 }, connect: () => {} }
    }

    createBufferSource() {
      const source = {
        buffer: null,
        connect: () => {},
        start: () => started.push(source.buffer),
      }
      return source
    }

    decodeAudioData(bytes) {
      return Promise.resolve(bytes)
    }

    resume() {
      return Promise.resolve()
    }
  }
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('fetch', vi.fn((url) => {
    const name = url.split('/').pop().replace('.mp3', '')
    if (!decoded.has(name)) decoded.set(name, { name })
    return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(decoded.get(name)) })
  }))
  return { started }
}

async function flush() {
  for (let i = 0; i < 25; i += 1) await Promise.resolve()
}

describe('board sounds', () => {
  let started

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    started = stubAudio().started
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('plays the capture sample for a capture that also gives check', async () => {
    const sounds = await import('./sounds')
    sounds.preloadSounds()
    await flush()

    sounds.playStepSound('Qxf7+')
    await flush()

    // lichess's standard theme has no check sound at all (Check.mp3 is a
    // symlink to Silence.mp3), so a checking capture is just a capture.
    expect(started.map(b => b.name)).toEqual(['Capture'])
  })

  it('plays the move sample for a quiet check, castling and promotion', async () => {
    const sounds = await import('./sounds')
    sounds.preloadSounds()
    await flush()

    for (const san of ['Qh5+', 'O-O', 'e8=Q']) {
      sounds.playStepSound(san)
      vi.advanceTimersByTime(200)
      await flush()
    }

    expect(started.map(b => b.name)).toEqual(['Move', 'Move', 'Move'])
  })

  it('throttles fast scrubbing instead of swallowing it', async () => {
    const sounds = await import('./sounds')
    sounds.preloadSounds()
    await flush()

    // Ten steps in quick succession, as when holding the arrow key down.
    for (let i = 0; i < 10; i += 1) {
      sounds.playStepSound('e4')
      vi.advanceTimersByTime(20)
      await flush()
    }
    vi.advanceTimersByTime(200)
    await flush()

    // Debouncing used to collapse the whole burst into one sound at the end.
    expect(started.length).toBeGreaterThan(1)
    expect(started.length).toBeLessThan(10)
  })

  it('plays the error sample for a rejected move', async () => {
    const sounds = await import('./sounds')
    sounds.preloadSounds()
    await flush()

    sounds.playIllegalSound()
    await flush()

    expect(started.map(b => b.name)).toEqual(['Error'])
  })
})
