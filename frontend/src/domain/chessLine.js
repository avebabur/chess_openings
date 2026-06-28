import { Chess } from 'chess.js'

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export function splitSanLine(line) {
  if (Array.isArray(line)) return line.filter(Boolean)
  return (line || '').split(/\s+/).filter(Boolean)
}

// Mainline SAN list from a full PGN. chess.js tolerates the [%clk] comments and
// PGN headers in our stored games; an unparseable PGN yields an empty line.
export function sansFromPgn(pgn) {
  const game = new Chess()
  try {
    game.loadPgn(pgn || '')
  } catch {
    return []
  }
  return game.history()
}

export function boardFromPath(path) {
  const game = new Chess()
  let last = null
  const accepted = []

  for (const san of splitSanLine(path)) {
    let move
    try {
      move = game.move(san)
    } catch {
      break
    }
    if (!move) break
    accepted.push(move.san)
    last = [move.from, move.to]
  }

  return { fen: game.fen(), last, accepted }
}

export function legalDests(fen) {
  const game = new Chess(fen)
  const dests = new Map()
  for (const move of game.moves({ verbose: true })) {
    const existing = dests.get(move.from) || []
    existing.push(move.to)
    dests.set(move.from, existing)
  }
  return dests
}

export function pieceAt(fen, square) {
  return new Chess(fen).get(square)
}

export function applySanMove(fen, san) {
  const game = new Chess(fen)
  try {
    const move = game.move(san)
    if (!move) return null
    return {
      move,
      san: move.san,
      from: move.from,
      to: move.to,
      fenAfter: game.fen(),
      last: [move.from, move.to],
    }
  } catch {
    return null
  }
}

export function findNodeByPath(root, path) {
  let node = root
  for (const san of splitSanLine(path)) {
    node = (node?.children || []).find(child => child.san === san)
    if (!node) return null
  }
  return node?.id ? node : null
}

export function needsPromotion(fen, orig, dest) {
  const game = new Chess(fen)
  const piece = game.get(orig)
  if (!piece || piece.type !== 'p') return false
  const rank = dest[1]
  return (piece.color === 'w' && rank === '8') || (piece.color === 'b' && rank === '1')
}

export function makeMove(fen, orig, dest, promotion = 'q') {
  const game = new Chess(fen)
  try {
    const move = game.move({ from: orig, to: dest, promotion })
    if (!move) return null
    return {
      move,
      san: move.san,
      from: move.from,
      to: move.to,
      promotion: move.promotion || promotion,
      fenAfter: game.fen(),
      last: [move.from, move.to],
    }
  } catch {
    return null
  }
}

export function tryMove(fen, orig, dest, promotion = 'q') {
  return makeMove(fen, orig, dest, promotion)?.move || null
}

export function isExpectedMove(moveResult, expected) {
  if (!moveResult || !expected) return false
  return moveResult.san === expected.san || (
    Boolean(expected.fen_after) && moveResult.fenAfter === expected.fen_after
  )
}

export function normalizeReviewNode(node) {
  const path = splitSanLine(node?.path_san)
  if (!node?.id || !path.length) return null
  return {
    id: node.id,
    path,
    priorPath: path.slice(0, -1),
    san: node.san,
    color: node.color,
    fen_after: node.fen_after,
  }
}

export function reviewQueueFromDueNodes(dueNodes) {
  return (dueNodes || []).map(normalizeReviewNode).filter(Boolean)
}

export function uciLineToSan(fen, uciMoves) {
  const game = new Chess(fen)
  const out = []
  for (const uci of uciMoves || []) {
    if (!uci || uci.length < 4) continue
    const from = uci.slice(0, 2)
    const to = uci.slice(2, 4)
    const piece = game.get(from)
    const target = game.get(to)
    const normalizedTo = piece?.type === 'k' && target?.type === 'r' && piece.color === target.color
      ? `${to[0] > from[0] ? 'g' : 'c'}${from[1]}`
      : to
    let move
    try {
      move = game.move({
        from,
        to: normalizedTo,
        promotion: uci[4] || 'q',
      })
    } catch {
      break
    }
    if (!move) break
    out.push(move.san)
  }
  return out
}
