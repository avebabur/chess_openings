import { Chess } from 'chess.js'
import { describe, expect, it } from 'vitest'
import positionKeyFixtures from '../../../backend/tests/data/position_key_fixtures.json'
import {
  START_FEN,
  applySanMove,
  boardFromPath,
  indexNodesByEpdBefore,
  isExpectedMove,
  legalDests,
  makeMove,
  matchExpectedMove,
  needsPromotion,
  positionKeyFromFen,
  positionKeysAlongPath,
  repliesAtPosition,
  reviewQueueFromDueNodes,
  sideToMove,
  splitSanLine,
} from './chessLine'

// The other half of the contract in backend/tests/test_position_key.py. Both
// suites read this one fixture file, so if chess.js and python-chess ever stop
// agreeing on what a position key is, one of them goes red.
describe('position keys agree with the backend', () => {
  it.each(positionKeyFixtures)('$name', ({ fen, line, key }) => {
    const game = fen ? new Chess(fen) : new Chess()
    for (const san of line.split(' ').filter(Boolean)) game.move(san)

    expect(positionKeyFromFen(game.fen())).toBe(key)
  })

  it('drops the move clocks so transpositions collapse', () => {
    const viaE4 = boardFromPath(['e4', 'e5', 'Nf3', 'Nc6']).fen
    const viaNf3 = boardFromPath(['Nf3', 'Nc6', 'e4', 'e5']).fen

    expect(viaE4).not.toBe(viaNf3)
    expect(positionKeyFromFen(viaE4)).toBe(positionKeyFromFen(viaNf3))
  })

  it('returns an empty key for a FEN it cannot read', () => {
    expect(positionKeyFromFen('')).toBe('')
    expect(positionKeyFromFen(undefined)).toBe('')
    expect(positionKeyFromFen('rnbq w KQkq')).toBe('')
  })

  it('reads side to move without substring-matching the whole FEN', () => {
    expect(sideToMove(START_FEN)).toBe('white')
    expect(sideToMove(boardFromPath(['e4']).fen)).toBe('black')
  })
})

describe('repertoire replies are found by position', () => {
  // Two saved lines reaching one position by different move orders, both
  // prescribing Nc3 there.
  const root = {
    children: [
      {
        id: 1, san: 'd4', epd_before: 'START', epd_after: 'A', label: 'main',
        path_san: 'd4', drill_count: 0,
        children: [{
          id: 2, san: 'Nf6', epd_before: 'A', epd_after: 'SHARED', label: 'main',
          path_san: 'd4 Nf6', drill_count: 0,
          children: [{
            id: 3, san: 'Nc3', epd_before: 'SHARED', epd_after: 'END', label: 'main',
            path_san: 'd4 Nf6 Nc3', drill_count: 4, children: [],
          }],
        }],
      },
      {
        id: 4, san: 'Nf3', epd_before: 'START', epd_after: 'B', label: 'sideline',
        path_san: 'Nf3', drill_count: 0,
        children: [{
          id: 5, san: 'd5', epd_before: 'B', epd_after: 'SHARED', label: 'main',
          path_san: 'Nf3 d5', drill_count: 0,
          children: [{
            id: 6, san: 'Nc3', epd_before: 'SHARED', epd_after: 'END', label: 'sideline',
            path_san: 'Nf3 d5 Nc3', drill_count: 1, children: [],
          }],
        }],
      },
    ],
  }

  it('indexes every node by the position it is played from', () => {
    const index = indexNodesByEpdBefore(root)

    expect(index.get('START').map(n => n.san)).toEqual(['d4', 'Nf3'])
    expect(index.get('SHARED').map(n => n.id)).toEqual([3, 6])
  })

  it('de-duplicates the same reply saved under two move orders', () => {
    const replies = repliesAtPosition(indexNodesByEpdBefore(root), 'SHARED')

    expect(replies).toHaveLength(1)
    expect(replies[0].san).toBe('Nc3')
    // Of the two spellings, keep the one with the drill history.
    expect(replies[0].id).toBe(3)
  })

  it('orders replies with main lines first', () => {
    const replies = repliesAtPosition(indexNodesByEpdBefore(root), 'START')

    expect(replies.map(r => r.san)).toEqual(['d4', 'Nf3'])
  })

  it('returns nothing for a position with no saved replies', () => {
    const index = indexNodesByEpdBefore(root)

    expect(repliesAtPosition(index, 'UNVISITED')).toEqual([])
    expect(repliesAtPosition(index, null)).toEqual([])
    expect(repliesAtPosition(null, 'START')).toEqual([])
  })
})

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

  it('accepts any saved reply when a card holds several', () => {
    const result = makeMove(START_FEN, 'd2', 'd4')

    expect(matchExpectedMove(result, [{ san: 'e4' }, { san: 'd4' }])?.san).toBe('d4')
    expect(matchExpectedMove(result, [{ san: 'e4' }, { san: 'c4' }])).toBeNull()
    expect(matchExpectedMove(result, [])).toBeNull()
  })

  it('matches a reply whose stored FEN differs only in the move clocks', () => {
    // The same position saved from a transposed line carries a different
    // halfmove clock; grading must not care.
    const start = boardFromPath(['e4', 'e5', 'Nf3']).fen
    const result = makeMove(start, 'b8', 'c6')
    const transposed = boardFromPath(['Nf3', 'Nc6', 'e4', 'e5']).fen

    expect(result.fenAfter).not.toBe(transposed)
    expect(isExpectedMove(result, { san: 'Nf6', fen_after: transposed })).toBe(true)
    expect(isExpectedMove(result, {
      san: 'Nf6', epd_after: positionKeyFromFen(transposed),
    })).toBe(true)
  })

  it('normalizes due nodes into review items with prior paths', () => {
    const queue = reviewQueueFromDueNodes([
      { id: 7, color: 'white', path_san: 'e4 e5 Nf3', san: 'Nf3', fen_after: 'fen' },
      { id: 8, path_san: '', san: 'e4' },
    ])

    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({
      id: 7,
      color: 'white',
      path: ['e4', 'e5', 'Nf3'],
      priorPath: ['e4', 'e5'],
      san: 'Nf3',
      fen_after: 'fen',
    })
  })

  it('falls back to the node itself when the server sends no accepted list', () => {
    const [item] = reviewQueueFromDueNodes([
      { id: 7, color: 'white', path_san: 'e4 e5 Nf3', san: 'Nf3', fen_after: 'fen' },
    ])

    expect(item.accepted).toEqual([{
      node_id: 7, san: 'Nf3', fen_after: 'fen', epd_after: null, path_san: 'e4 e5 Nf3',
    }])
  })

  it('carries every accepted reply so a transposed answer is credited', () => {
    const [item] = reviewQueueFromDueNodes([
      {
        id: 7,
        color: 'white',
        path_san: 'd4',
        san: 'd4',
        epd_before: 'start-key',
        accepted: [
          { node_id: 7, san: 'd4', path_san: 'd4' },
          { node_id: 9, san: 'e4', path_san: 'e4' },
        ],
      },
    ])
    const played = makeMove(START_FEN, 'e2', 'e4')

    expect(item.epd_before).toBe('start-key')
    expect(matchExpectedMove(played, item.accepted)?.node_id).toBe(9)
  })
})

describe('positionKeysAlongPath', () => {
  it('keys the start and every position of the line in one replay', () => {
    const line = 'd4 Nf6 c4 e6'
    const keys = positionKeysAlongPath(line)
    expect(keys).toHaveLength(5)
    expect(keys[0]).toBe(positionKeyFromFen(START_FEN))
    splitSanLine(line).forEach((_san, i) => {
      expect(keys[i + 1]).toBe(positionKeyFromFen(boardFromPath(splitSanLine(line).slice(0, i + 1)).fen))
    })
  })

  it('stops at the first illegal move', () => {
    expect(positionKeysAlongPath('e4 e5 Ke3 Nc6')).toHaveLength(3)
  })
})
