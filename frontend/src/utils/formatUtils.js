/** The opening family ("Caro-Kann Defense: Advance" → "Caro-Kann Defense"). */
export function openingFamily(name) {
  return (name || '').split(':')[0].trim()
}

/** The variation within a family ("Caro-Kann Defense: Advance" → "Advance").
 *  Empty for a bare family name (the base line of the family). */
export function openingVariation(name) {
  const idx = (name || '').indexOf(':')
  return idx === -1 ? '' : name.slice(idx + 1).trim()
}

export function lineMoves(line) {
  if (!line) return []
  if (Array.isArray(line.pv)) return line.pv.filter(Boolean)
  if (line.moves) return line.moves.split(' ').filter(Boolean)
  if (line.best_move) return [line.best_move]
  return []
}

/**
 * Status label for the Stockfish line. `target` is the search target object from
 * usePositionEval: `{ secs }` (secs may be Infinity for ∞) or `{ depth }` (frozen).
 * The achieved depth is the headline so you always know how far a time-based search
 * got, e.g. "d24 · 4s", "→ 4s" before the first frame, "d31 ∞", "d31" (frozen).
 */
export function stockfishDepthLabel(depth, target, searching = false) {
  if (target?.secs === Infinity) return depth ? `d${depth} ∞` : 'd… ∞'
  if (target?.depth != null) return depth ? `d${depth}` : `d${target.depth}`
  const secs = target?.secs ?? 4
  if (!depth) return searching ? `→ ${secs}s` : `${secs}s`
  return `d${depth} · ${secs}s`
}

export function pct(n) {
  return `${Math.round(n)}%`
}

const _compactFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

/** Large counts → compact form, e.g. 1234567 → "1.2M". */
export function compactNum(n) {
  return _compactFmt.format(n || 0)
}

export function shortMoves(moves, max = 8) {
  const parts = (moves || '').split(' ').filter(Boolean)
  if (parts.length <= max) return moves
  return `${parts.slice(0, max).join(' ')} …`
}

/** Numbered SAN line, e.g. ["e4","Nf6","Nf3"] → "1.e4 Nf6 2.Nf3". */
export function formatMoveLine(sans, maxPlies = 12) {
  const shown = sans.slice(0, maxPlies)
  const out = shown
    .map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}.${san}` : san))
    .join(' ')
  return sans.length > maxPlies ? `${out} …` : out
}

/** White-POV pawn eval → 0–100 white-advantage fill (saturates near ±4). */
export function evalToWhitePct(value) {
  if (value == null) return 50
  if (Math.abs(value) >= 100) return value > 0 ? 98 : 2
  const pctVal = 100 / (1 + Math.exp(-0.42 * value))
  return Math.max(3, Math.min(97, pctVal))
}

/** Eval number → display string. Mates encoded as ±(1000+|n|) become "M5"/"-M3". */
export function formatEval(v) {
  if (Math.abs(v) >= 900) {
    const mateIn = Math.round(Math.abs(v) - 1000)
    return v > 0 ? `M${mateIn}` : `-M${mateIn}`
  }
  if (Math.abs(v) >= 100) {
    return v > 0 ? 'M' : '-M'
  }
  return v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2)
}

export function branchScore(branch) {
  if (!branch.drill_count) return 'Not drilled yet'
  return `${branch.drill_solved}/${branch.drill_count} clean`
}

export function branchCleanRate(branch) {
  if (!branch?.drill_count) return null
  return Math.round((branch.drill_solved / branch.drill_count) * 100)
}
