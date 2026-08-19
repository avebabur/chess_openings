import { Chess } from 'chess.js'

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// The backend's definition of "the same position" (backend/position_key.py):
// the FEN's first four fields — placement, side to move, castling rights, and
// the en-passant square — dropping the two move clocks, which are the only
// fields a transposition changes. chess.js and python-chess both write an
// en-passant square only when the capture is actually legal, so slicing is
// enough; backend/tests/data/position_key_fixtures.json is asserted by this
// suite and by pytest so the two can't drift apart unnoticed.
export function positionKeyFromFen(fen) {
  const fields = (fen || '').split(' ')
  return fields.length < 4 ? '' : fields.slice(0, 4).join(' ')
}

export function sideToMove(fen) {
  return positionKeyFromFen(fen).split(' ')[1] === 'b' ? 'black' : 'white'
}

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

/** Is the side to move in check? Drives chessground's `check` highlight.
 *
 * Chessground will not derive this itself: `highlight.check` only decides
 * whether to paint `state.check`, which stays undefined until a `check` value
 * is passed in. Cheap enough to recompute per position (one Chess parse).
 */
export function isCheckFen(fen) {
  if (!fen) return false
  try {
    return new Chess(fen).isCheck()
  } catch {
    return false
  }
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

// Every repertoire node grouped by the position it is played FROM, so replies
// can be looked up by where you are rather than by how you got there.
export function indexNodesByEpdBefore(root) {
  const index = new Map()
  const walk = (node) => {
    for (const child of node?.children || []) {
      if (child.epd_before) {
        const bucket = index.get(child.epd_before)
        if (bucket) bucket.push(child)
        else index.set(child.epd_before, [child])
      }
      walk(child)
    }
  }
  walk(root)
  return index
}

// The saved replies at a position, de-duplicated by move — the same reply saved
// under two move orders is one option. 'main' lines sort first, then by how much
// they've been drilled, so the most established reply leads.
const LABEL_RANK = { main: 0, alternative: 1, trap: 2, sideline: 3 }

export function repliesAtPosition(index, epd) {
  if (!index || !epd) return []
  const bySan = new Map()
  for (const node of index.get(epd) || []) {
    const existing = bySan.get(node.san)
    if (!existing || (node.drill_count || 0) > (existing.drill_count || 0)) {
      bySan.set(node.san, node)
    }
  }
  return [...bySan.values()].sort((a, b) => (
    (LABEL_RANK[a.label] ?? 9) - (LABEL_RANK[b.label] ?? 9)
    || (b.drill_count || 0) - (a.drill_count || 0)
    || a.san.localeCompare(b.san)
  ))
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

// Which of the saved replies the player just made, or null for none of them.
// `expected` is one reply or a list — a review card collapses every move order
// into a single question, so several answers can be right.
//
// Matching is by position, not FEN string: two replies can reach one position by
// different move orders, and only the move clocks would differ.
export function matchExpectedMove(moveResult, expected) {
  if (!moveResult || !expected) return null
  const candidates = Array.isArray(expected) ? expected : [expected]
  const playedKey = positionKeyFromFen(moveResult.fenAfter)
  return candidates.find(reply => reply && (
    reply.san === moveResult.san
    || (reply.epd_after && reply.epd_after === playedKey)
    || (reply.fen_after && positionKeyFromFen(reply.fen_after) === playedKey)
  )) || null
}

export function isExpectedMove(moveResult, expected) {
  return matchExpectedMove(moveResult, expected) !== null
}

export function normalizeReviewNode(node) {
  const path = splitSanLine(node?.path_san)
  if (!node?.id || !path.length) return null
  // `accepted` comes from the server: every reply saved at this position, so a
  // transposed-but-saved answer isn't graded wrong. Older payloads without it
  // fall back to this node's own move.
  const accepted = (node.accepted || []).filter(reply => reply?.node_id)
  return {
    id: node.id,
    path,
    priorPath: path.slice(0, -1),
    san: node.san,
    color: node.color,
    fen_after: node.fen_after,
    epd_before: node.epd_before || null,
    epd_after: node.epd_after || null,
    accepted: accepted.length ? accepted : [{
      node_id: node.id,
      san: node.san,
      fen_after: node.fen_after,
      epd_after: node.epd_after || null,
      path_san: node.path_san,
    }],
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
