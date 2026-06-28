import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Chessground } from 'chessground'
import Board from './Chessground'

const { api } = vi.hoisted(() => ({
  api: { set: vi.fn(), setAutoShapes: vi.fn(), redrawAll: vi.fn(), destroy: vi.fn() },
}))

vi.mock('chessground', () => ({ Chessground: vi.fn(() => api) }))

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
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
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
})
