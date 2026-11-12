/* What the left rail shows while a drill or review is running.
 *
 * The rail can't show EnginePanel mid-session — Stockfish's best line and the
 * Lichess-players list both give away the move you're being asked for. It used to
 * be unmounted entirely, but that collapsed the whole 3-column shell the instant a
 * run started (board jumped, panel shrank, a 300px hole opened on the left). So the
 * column stays put and carries the run's progress instead, which also keeps the
 * board column short enough to fit the viewport.
 */
export default function SessionRail({
  isTraining,
  trainerStrip,
  isReviewing,
  review,
  reviewItem,
  reviewCompleted,
  playSession,
}) {
  if (isTraining && trainerStrip) {
    return (
      <div className="op-practice-strip" role="status">
        <div className="op-practice-strip-head">
          <span>Drilling: {trainerStrip.label}</span>
          <span>{trainerStrip.done}/{trainerStrip.total} lines</span>
        </div>
        <div className="op-practice-progress">
          <div className="op-practice-progress-fill" style={{ width: `${trainerStrip.progress}%` }} />
        </div>
      </div>
    )
  }

  if (isReviewing) {
    return (
      <div className="op-practice-strip review" role="status">
        <div className="op-practice-strip-head">
          <span>Reviewing · find the move for {reviewItem.color === 'white' ? 'White' : 'Black'}</span>
          <span>{review.idx + 1}/{review.queue.length}</span>
        </div>
        <div className="op-practice-progress">
          <div
            className="op-practice-progress-fill"
            style={{ width: `${Math.round((reviewCompleted / review.queue.length) * 100)}%` }}
          />
        </div>
      </div>
    )
  }

  if (playSession) {
    const userMoves = playSession.moves.filter(move => move.by === 'user')
    const judged = userMoves.filter(move => move.verdict)
    const mistakes = judged.filter(move => move.verdict.mistake).length
    return (
      <div className="op-practice-strip" role="status">
        <div className="op-practice-strip-head">
          <span>Playing Stockfish as {playSession.userColor === 'white' ? 'White' : 'Black'}</span>
          <span>{userMoves.length} move{userMoves.length === 1 ? '' : 's'}</span>
        </div>
        <p className="play-rail-note">
          {judged.length
            ? `Tablebase: ${judged.length - mistakes} of ${judged.length} moves kept the result.`
            : 'The engine panel is hidden during a game, like the answers in a drill.'}
        </p>
      </div>
    )
  }

  return null
}
