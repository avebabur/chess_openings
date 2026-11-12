import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Chessground } from '@lichess-org/chessground'
import Board from './Chessground'

const { api } = vi.hoisted(() => ({
  api: {
    set: vi.fn(),
    setAutoShapes: vi.fn(),
    redrawAll: vi.fn(),
    destroy: vi.fn(),
    playPremove: vi.fn(),
    cancelPremove: vi.fn(),
  },
}))

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'

const setCalls = () => api.set.mock.calls.map(([config]) => config)

vi.mock('@lichess-org/chessground', () => ({ Chessground: vi.fn(() => api) }))

describe('Chessground reset behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('requestAnimationFrame', (callback) => { callback(); return 1 })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('reconciles a rejected move without remounting the board', () => {
    const props = {
      boardSize: 320,
      fen: START,
      movableDests: new Map(),
      onMove: vi.fn(),
    }
    const view = render(<Board {...props} resetKey={0} />)
    for (let resetKey = 1; resetKey <= 20; resetKey += 1) {
      view.rerender(<Board {...props} resetKey={resetKey} />)
    }

    expect(Chessground).toHaveBeenCalledTimes(1)
    expect(api.destroy).not.toHaveBeenCalled()
    expect(api.set).toHaveBeenCalledTimes(21)
  })

  it('sends check on every position change so the highlight can clear', () => {
    const props = { boardSize: 320, movableDests: new Map(), onMove: vi.fn() }
    const view = render(<Board {...props} fen={START} check={false} />)
    view.rerender(<Board {...props} fen={AFTER_E4} check />)
    view.rerender(<Board {...props} fen={START} check={false} />)

    // configure() reads `config.check || false`, so the key has to be present
    // even when there is no check — otherwise the king stays lit.
    const positionCalls = setCalls().filter(config => 'fen' in config)
    expect(positionCalls.map(config => config.check)).toEqual([true, false])
  })

  it('clears viewOnly before flipping, and rebinds a board flipped while frozen', () => {
    // chessground's toggleOrientation() wipes and rebuilds the board DOM, and
    // events.bindBoard early-returns while viewOnly — so a rebuild during a
    // promotion dialog leaves the board with no pointer listeners.
    const props = {
      boardSize: 320,
      fen: START,
      movableDests: new Map(),
      onMove: vi.fn(),
    }
    const view = render(<Board {...props} orientation="white" />)
    api.set.mockClear()
    api.redrawAll.mockClear()

    // Frozen (promotion open) and flipped: the rebuild binds nothing.
    view.rerender(<Board {...props} orientation="black" disabled />)
    const calls = setCalls()
    const viewOnlyIndex = calls.findIndex(config => 'viewOnly' in config)
    const orientationIndex = calls.findIndex(config => 'orientation' in config)
    expect(viewOnlyIndex).toBeGreaterThanOrEqual(0)
    expect(orientationIndex).toBeGreaterThan(viewOnlyIndex)
    expect(api.redrawAll).not.toHaveBeenCalled()

    // Dialog closes: the board must be rebuilt so the listeners come back.
    view.rerender(<Board {...props} orientation="black" />)
    expect(api.redrawAll).toHaveBeenCalled()
  })

  it('does not rebuild the board when it was never flipped while frozen', () => {
    const props = {
      boardSize: 320,
      fen: START,
      movableDests: new Map(),
      onMove: vi.fn(),
    }
    const view = render(<Board {...props} orientation="white" />)
    api.redrawAll.mockClear()

    view.rerender(<Board {...props} orientation="white" disabled />)
    view.rerender(<Board {...props} orientation="white" />)

    // Every redrawAll leaks a ResizeObserver in chessground, so it must not
    // fire just because a dialog opened and closed.
    expect(api.redrawAll).not.toHaveBeenCalled()
  })

  it('plays a queued premove only once the turn and the legal moves are back', () => {
    const dests = new Map([['e2', ['e4']]])
    const props = { boardSize: 320, onMove: vi.fn(), premove: true, movableColor: 'white' }

    // Black to move: white may queue a move but nothing is played yet.
    const view = render(<Board {...props} fen={AFTER_E4} movableDests={null} />)
    expect(Chessground.mock.calls[0][1].premovable.enabled).toBe(true)
    expect(api.playPremove).not.toHaveBeenCalled()

    // The reply lands, white is to move and has legal moves again.
    view.rerender(<Board {...props} fen={START} movableDests={dests} />)
    expect(api.playPremove).toHaveBeenCalledTimes(1)

    // The interaction config that preceded it must already carry the new dests,
    // or chessground would test the premove against the old position.
    const lastMovable = setCalls().filter(config => config.movable).at(-1)
    expect(lastMovable.movable.dests).toBe(dests)
  })

  it('never plays a premove when premoves are off or both colours move', () => {
    const dests = new Map([['e2', ['e4']]])
    const view = render(<Board boardSize={320} onMove={vi.fn()} fen={AFTER_E4} movableDests={null} />)
    view.rerender(<Board boardSize={320} onMove={vi.fn()} fen={START} movableDests={dests} movableColor="white" />)
    expect(Chessground.mock.calls[0][1].premovable.enabled).toBe(false)
    expect(api.playPremove).not.toHaveBeenCalled()
  })

  it('lets the user draw arrows, as on lichess', () => {
    render(<Board boardSize={320} onMove={vi.fn()} fen={START} movableDests={new Map()} />)
    const { drawable } = Chessground.mock.calls[0][1]
    expect(drawable.enabled).toBe(true)
    expect(drawable.eraseOnMovablePieceClick).toBe(true)
  })

  it('drops a queued premove when the parent rejects a move', () => {
    const props = { boardSize: 320, fen: START, movableDests: new Map(), onMove: vi.fn(), premove: true, movableColor: 'white' }
    const view = render(<Board {...props} resetKey={0} />)
    api.cancelPremove.mockClear()
    view.rerender(<Board {...props} resetKey={1} />)
    expect(api.cancelPremove).toHaveBeenCalledTimes(1)
  })
})
