/* Goals for the Lichess Practice positions.
 *
 * A goal is `{ kind, cp, moves }` as the backend stores it (see
 * backend/practice_library.py). This file says, in plain words, what each goal
 * asks for, and decides from the moves played so far whether it is reached,
 * missed or still open. Like the rest of the play session it is derived from
 * the moves every time, so taking a move back needs no special handling.
 *
 * How each kind is judged ("your moves" means moves the user made):
 *
 *   mate        checkmate, within `moves` of yours if a limit is set.
 *   eval        after one of your first `moves` moves, the position must be
 *               rated at least `cp` in your favour. Missed if none is.
 *   promotion   the move that promotes must leave you at least `cp` better.
 *               Missed early if the tablebase says you let the win go.
 *   win         like promotion, with "winning" (300cp) as the bar, for the
 *               exercises whose title says "= Win".
 *   equalize    after one of your first `moves` moves, the position must be
 *               rated no worse than -50cp for you.
 *   draw        survive `moves` moves without the tablebase (or a rating of
 *               -300cp) saying you have lost.
 *   better      a mistake from one of your own games (see mistakeGoal). You
 *               get one move; it must leave you rated at least `cp`, which is
 *               a little below what the best move keeps. The move you played
 *               in the game fails at once.
 *
 * The rating of a position comes from the reply the backend sends after each
 * of your moves: the tablebase result with seven pieces or fewer, Stockfish's
 * rating otherwise. A tablebase win counts as +10000cp, a draw as 0.
 */

export const TABLEBASE_WIN_CP = 10000
const WIN_CP = 300
const EQUAL_CP = -50
const LOST_CP = -300

const OUTCOME_CP = { win: TABLEBASE_WIN_CP, draw: 0, loss: -TABLEBASE_WIN_CP }
const FLIP = { win: 'loss', loss: 'win', draw: 'draw' }

/**
 * What the reply to a user move tells about the position after it, from the
 * user's side: `{ cp, outcome }`, either may be null. `reply.outcome` is the
 * replying (opponent's) result; `reply.cp` is from White's side.
 */
export function assessmentFromReply(reply, userColor) {
  const outcome = reply?.outcome ? FLIP[reply.outcome] ?? null : null
  let cp = null
  if (outcome) cp = OUTCOME_CP[outcome]
  else if (Number.isFinite(reply?.cp)) cp = userColor === 'white' ? reply.cp : -reply.cp
  return { cp, outcome }
}

/** Does a drawn game count as reaching this goal? */
function drawIsEnough(goal) {
  return goal.kind === 'equalize' || goal.kind === 'draw' || (goal.kind === 'better' && goal.cp <= 0)
}

/** A rating from your side in words: "+1.2", "-0.4", "winning", "a draw". */
export function ratingText(cp, source) {
  if (cp >= 9000) return 'winning'
  if (cp <= -9000) return 'lost'
  if (source === 'tablebase' && cp === 0) return 'a draw'
  return `${cp > 0 ? '+' : cp < 0 ? '-' : ''}${(Math.abs(cp) / 100).toFixed(1)}`
}

/** The one-move exercise for a mistake row from GET /api/mistakes. */
export function mistakeGoal(mistake) {
  return {
    kind: 'better',
    cp: mistake.target_cp,
    played: mistake.played_san,
    playedUci: mistake.played_uci,
    best: mistake.best_san,
    before: mistake.cp_before,
    after: mistake.cp_after,
    source: mistake.source,
  }
}

export function isPlayableGoal(goal) {
  return Boolean(goal) && goal.kind !== 'study'
}

function pawns(cp) {
  const value = Math.abs(cp) / 100
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function movesText(count) {
  return count === 1 ? 'one move' : `${count} moves`
}

/** The goal as a sentence, and a second line of detail where one helps. */
export function describeGoal(goal) {
  if (!goal) return null
  switch (goal.kind) {
    case 'mate':
      return {
        title: goal.moves ? `Checkmate in ${movesText(goal.moves)}` : 'Checkmate the opponent',
        detail: goal.moves === 1
          ? 'You have one move to give checkmate.'
          : goal.moves
            ? `Count your own moves only. Mate by your ${ordinal(goal.moves)} move at the latest.`
            : 'There is no move limit.',
      }
    case 'eval':
      return {
        title: `Be ${pawns(goal.cp)} pawn${goal.cp === 100 ? '' : 's'} better within ${movesText(goal.moves)}`,
        detail: `Stockfish has to rate your position at least +${pawns(goal.cp)} for you. Winning material counts, and so does a better position.`,
      }
    case 'promotion':
      return {
        title: 'Promote a pawn and keep the advantage',
        detail: goal.cp >= TABLEBASE_WIN_CP
          ? 'Promote without letting the win slip.'
          : `After you promote, the position must still be at least +${pawns(goal.cp)} for you.`,
      }
    case 'win':
      return {
        title: 'Win the position',
        detail: 'Promote a pawn or give checkmate without letting the win slip.',
      }
    case 'equalize':
      return {
        title: `Equalize within ${movesText(goal.moves)}`,
        detail: 'You are worse. Reach a position that is level, or better, in that many moves.',
      }
    case 'better':
      return {
        title: `Find a better move than ${goal.played}`,
        detail: `In your game ${goal.played} took you from ${ratingText(goal.before, goal.source)} to ${ratingText(goal.after, goal.source)}. You get one move, and Stockfish rates it.`,
      }
    case 'draw':
      return {
        title: `Hold the draw for ${goal.moves} moves`,
        detail: 'Do not lose. If you survive that long, or the game is drawn, you have succeeded.',
      }
    default:
      return { title: 'No goal', detail: 'This one is a lesson. Play it out from here.' }
  }
}

/** A few words for a list: "Mate in 3", "+3 pawns in 2", "Hold 20 moves". */
export function goalLabel(goal) {
  if (!goal) return ''
  switch (goal.kind) {
    case 'mate': return goal.moves ? `Mate in ${goal.moves}` : 'Checkmate'
    case 'eval': return `+${pawns(goal.cp)} in ${goal.moves}`
    case 'promotion': return goal.cp >= TABLEBASE_WIN_CP ? 'Promote' : `Promote, +${pawns(goal.cp)}`
    case 'win': return 'Win'
    case 'equalize': return `Equalize in ${goal.moves}`
    case 'draw': return `Hold ${goal.moves} moves`
    case 'better': return `Better than ${goal.played}`
    default: return 'Lesson'
  }
}

function ordinal(n) {
  const rest = n % 100
  if (rest >= 11 && rest <= 13) return `${n}th`
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`
}

const solved = (reason, extra = {}) => ({ state: 'solved', reason, ...extra })
const failed = (reason, extra = {}) => ({ state: 'failed', reason, ...extra })

/** Did this user move promote a pawn? (`uci` is `e7e8q` for a promotion.) */
function promotes(move) {
  return typeof move.uci === 'string' && move.uci.length === 5
}

/**
 * Where the goal stands. Returns null when there is nothing to judge,
 * otherwise `{ state: 'running' | 'solved' | 'failed', reason, used, limit }`.
 * `result` is the game result from `gameResult` (null while the game goes on).
 */
export function judgeGoal({ goal, userColor, moves, result }) {
  if (!isPlayableGoal(goal)) return null
  const userMoves = moves.filter(move => move.by === 'user')
  const used = userMoves.length
  const limit = goal.moves ?? null
  const base = (verdict) => ({ ...verdict, used, limit })

  if (result?.reason === 'checkmate') {
    return base(result.winner === userColor ? solved('checkmate') : failed('checkmated'))
  }
  if (result) {
    // Stalemate, repetition and the like.
    return base(drawIsEnough(goal) ? solved('drawn') : failed('drawn'))
  }

  const rated = userMoves.map(move => move.assessment || null)
  const last = rated.at(-1) ?? null
  const lastCp = last?.cp ?? null

  switch (goal.kind) {
    case 'mate':
      return base(limit && used >= limit ? failed('too-slow') : { state: 'running' })

    case 'eval': {
      const index = rated.findIndex((a, i) => i < limit && a?.cp != null && a.cp >= goal.cp)
      if (index >= 0) return base(solved('rating', { cp: rated[index].cp }))
      if (used >= limit && last) return base(failed('short', { cp: lastCp }))
      return base({ state: 'running' })
    }

    case 'promotion':
    case 'win': {
      const bar = goal.kind === 'win' ? WIN_CP : goal.cp
      for (let i = 0; i < userMoves.length; i += 1) {
        const a = rated[i]
        if (!a) return base({ state: 'running' })
        if (promotes(userMoves[i])) {
          return base(a.cp != null && a.cp >= bar ? solved('promoted', { cp: a.cp }) : failed('promoted-weak', { cp: a.cp }))
        }
        // Only the tablebase can say a win was thrown away before promotion.
        if (a.outcome && a.outcome !== 'win') return base(failed('lost-win'))
      }
      return base({ state: 'running' })
    }

    case 'equalize': {
      const index = rated.findIndex((a, i) => i < limit && a?.cp != null && a.cp >= EQUAL_CP)
      if (index >= 0) return base(solved('level', { cp: rated[index].cp }))
      if (used >= limit && last) return base(failed('still-worse', { cp: lastCp }))
      return base({ state: 'running' })
    }

    case 'better': {
      const first = userMoves[0]
      if (!first) return base({ state: 'running' })
      if (first.uci === goal.playedUci) return base(failed('same-move'))
      const cp = rated[0]?.cp
      if (cp == null) return base({ state: 'running' })
      const extra = { cp, san: first.san }
      return base(cp >= goal.cp ? solved('better', extra) : failed('not-better', extra))
    }

    case 'draw': {
      const slipped = rated.findIndex(a => a && (a.outcome === 'loss' || (a.cp != null && a.cp <= LOST_CP)))
      if (slipped >= 0) return base(failed('lost'))
      if (used >= limit && last) return base(solved('held'))
      return base({ state: 'running' })
    }

    default:
      return null
  }
}

/** A user-facing line for a finished goal. */
export function goalOutcomeText(goal, judgement) {
  if (!judgement || judgement.state === 'running') return null
  const shown = judgement.cp != null && Math.abs(judgement.cp) < TABLEBASE_WIN_CP
    ? `${judgement.cp > 0 ? '+' : judgement.cp < 0 ? '-' : ''}${pawns(judgement.cp)}`
    : null
  switch (judgement.reason) {
    case 'checkmate':
      return { title: 'Checkmate. Goal reached.', body: `You did it in ${movesText(judgement.used)}.` }
    case 'rating':
      return {
        title: 'Goal reached',
        body: shown ? `Stockfish now rates your position ${shown} for you.` : 'Your position is now winning.',
      }
    case 'promoted':
      return {
        title: 'Promoted and still winning',
        body: shown ? `Stockfish rates it ${shown} for you.` : 'The tablebase confirms the win.',
      }
    case 'level':
      return { title: 'You equalized', body: 'The position is level, or better, for you.' }
    case 'held':
      return { title: 'You held the draw', body: `You got through ${judgement.limit} moves without losing.` }
    case 'drawn':
      return drawIsEnough(goal)
        ? { title: 'Drawn. Goal reached.', body: 'The game ended in a draw, which is what you needed.' }
        : { title: 'The game was drawn', body: 'The goal was more than a draw.' }
    case 'better':
      return {
        title: `${judgement.san} is better`,
        body: `${shown ? `Stockfish rates it ${shown} for you.` : 'It keeps the result.'} ${
          judgement.san === goal.best ? 'It is Stockfish\'s first choice too.' : `Its own choice was ${goal.best}.`}`,
      }
    case 'not-better':
      return {
        title: `${judgement.san} does not fix it`,
        body: `${shown ? `Stockfish rates it ${shown} for you. ` : ''}It would have played ${goal.best}.`,
      }
    case 'same-move':
      return { title: 'That is the move from the game', body: 'It is the one that went wrong. Look for something else.' }
    case 'checkmated':
      return { title: 'You were checkmated', body: 'Try the position again.' }
    case 'too-slow':
      return { title: 'No mate in time', body: `The goal was mate within ${movesText(goal.moves)}. Look for a quicker way.` }
    case 'short':
      return {
        title: 'Not enough',
        body: shown
          ? `After ${movesText(judgement.used)} Stockfish rates you ${shown}, and the goal was +${pawns(goal.cp)}.`
          : `After ${movesText(judgement.used)} you were still short of the goal.`,
      }
    case 'still-worse':
      return {
        title: 'Still worse',
        body: shown ? `Stockfish rates you ${shown} after ${movesText(judgement.used)}.` : 'The position did not level out in time.',
      }
    case 'promoted-weak':
      return {
        title: 'Promoted, but it is not enough',
        body: shown ? `Stockfish rates it ${shown}, and the goal was +${pawns(goal.cp ?? WIN_CP)}.` : 'The advantage was not big enough.',
      }
    case 'lost-win':
      return { title: 'The win slipped away', body: 'That move turned a winning position into a draw or worse.' }
    case 'lost':
      return { title: 'The draw slipped away', body: 'That move leaves you lost.' }
    default:
      return { title: judgement.state === 'solved' ? 'Goal reached' : 'Goal missed', body: '' }
  }
}
