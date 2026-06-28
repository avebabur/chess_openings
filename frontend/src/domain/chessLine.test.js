import { describe, expect, it } from 'vitest'
import {
  START_FEN,
  applySanMove,
  boardFromPath,
  isExpectedMove,
  legalDests,
  makeMove,
  needsPromotion,
  reviewQueueFromDueNodes,
} from './chessLine'

describe('chessLine domain helpers', () => {
  it('derives FEN and last move from a SAN path', () => {
    const board = boardFromPath(['e4', 'e5', 'Nf3'])

    expect(board.accepted).toEqual(['e4', 'e5', 'Nf3'])
    expect(board.last).toEqual(['g1', 'f3'])
    expect(board.fen).toContain(' b ')
  })

  it('stops at invalid SAN without throwing', () => {
    const board = boardFromPath(['e4', 'e5', 'e5', 'Nf3'])

    expect(board.accepted).toEqual(['e4', 'e5'])
    expect(board.fen).toContain(' w ')
  })

  it('generates legal destinations for the current FEN', () => {
    const dests = legalDests(START_FEN)

    expect(dests.get('e2')).toContain('e4')
    expect(dests.get('g1')).toContain('f3')
  })

  it('detects and completes promotion moves', () => {
    const fen = '8/P7/8/8/8/8/8/k6K w - - 0 1'

    expect(needsPromotion(fen, 'a7', 'a8')).toBe(true)
    expect(makeMove(fen, 'a7', 'a8', 'q')?.san).toBe('a8=Q+')
  })

  it('compares expected moves by SAN and resulting FEN', () => {
    const result = makeMove(START_FEN, 'e2', 'e4')
    const sameFen = applySanMove(START_FEN, 'e4')

    expect(isExpectedMove(result, { san: 'e4' })).toBe(true)
    expect(isExpectedMove(result, { san: 'e3', fen_after: sameFen.fenAfter })).toBe(true)
    expect(isExpectedMove(result, { san: 'd4' })).toBe(false)
  })

  it('normalizes due nodes into review items with prior paths', () => {
    const queue = reviewQueueFromDueNodes([
      { id: 7, color: 'white', path_san: 'e4 e5 Nf3', san: 'Nf3', fen_after: 'fen' },
      { id: 8, path_san: '', san: 'e4' },
    ])

    expect(queue).toEqual([
      {
        id: 7,
        color: 'white',
        path: ['e4', 'e5', 'Nf3'],
        priorPath: ['e4', 'e5'],
        san: 'Nf3',
        fen_after: 'fen',
      },
    ])
  })
})
