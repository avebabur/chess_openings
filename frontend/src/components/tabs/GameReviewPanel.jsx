import { useEffect, useMemo, useRef } from 'react'
import { positionKeysAlongPath } from '../../domain/chessLine'

function resultPov(result, userColor) {
  if (result === '1/2-1/2') return 'draw'
  if (userColor !== 'white' && userColor !== 'black') return null
  if (result === '1-0') return userColor === 'white' ? 'win' : 'loss'
  if (result === '0-1') return userColor === 'black' ? 'win' : 'loss'
  return null
}

const POV_LABEL = { win: 'Win', draw: 'Draw', loss: 'Loss' }

/**
 * Header + clickable move list for a game opened in the review board. Stepping
 * is driven by the shared line state in OpeningsExplorer; `currentPly` is how
 * many of the game's moves are currently on the board (a leading prefix match,
 * so playing a side variation just leaves nothing highlighted past the split).
 */
export default function GameReviewPanel({ game, sans, currentPly, onSelectPly, onClose, onPlayFromHere, notes }) {
  const pov = resultPov(game.result, game.user_color)
  const whiteRating = game.user_color === 'white' ? game.user_rating : game.opp_rating
  const blackRating = game.user_color === 'black' ? game.user_rating : game.opp_rating
  const opening = game.opening || game.eco || 'Unknown opening'

  // The game's own page, so you can go back to chess.com from here.
  const chesscomUrl = (game.pgn || '').match(/\[Link "(https:\/\/www\.chess\.com\/[^"\s]+)"\]/)?.[1]

  const movesRef = useRef(null)
  const currentRef = useRef(null)

  // Keep the move on the board visible as you step through with the keyboard:
  // the list caps at ~19 rows before it scrolls, so nudge the container (never
  // the page) just enough to reveal the highlighted move.
  useEffect(() => {
    const container = movesRef.current
    if (!container) return
    const el = currentRef.current
    if (!el) { container.scrollTop = 0; return }
    const cRect = container.getBoundingClientRect()
    const eRect = el.getBoundingClientRect()
    if (eRect.top < cRect.top) container.scrollTop += eRect.top - cRect.top
    else if (eRect.bottom > cRect.bottom) container.scrollTop += eRect.bottom - cRect.bottom
  }, [currentPly])

  const rows = []
  for (let i = 0; i < sans.length; i += 2) {
    rows.push({ no: i / 2 + 1, w: { san: sans[i], ply: i }, b: sans[i + 1] != null ? { san: sans[i + 1], ply: i + 1 } : null })
  }

  // Your mistakes in this game, once it has been analysed from the Play tab.
  const mistakeAt = new Map((game.mistakes || []).map(m => [m.ply, m]))
  // keys[i + 1] is the position after move i; a comment on it marks that move.
  const keys = useMemo(() => positionKeysAlongPath(sans), [sans])

  const cell = (m) => {
    if (!m) return <span className="grm-san empty" />
    const played = m.ply < currentPly
    const current = m.ply === currentPly - 1
    const mistake = mistakeAt.get(m.ply)
    const note = notes?.get(keys[m.ply + 1])
    return (
      <button
        type="button"
        ref={current ? currentRef : null}
        className={`grm-san${current ? ' current' : ''}${played ? ' played' : ''}`}
        onClick={() => onSelectPly(m.ply + 1)}
        title={[mistake && `Stockfish preferred ${mistake.best_san}`, note].filter(Boolean).join(' · ') || undefined}
      >
        {m.san}
        {note && <span className="note-mark" aria-label="has a comment">✎</span>}
        {mistake && (
          <span className={`mistake-kind ${mistake.kind}`}>{mistake.kind === 'blunder' ? '??' : '?'}</span>
        )}
      </button>
    )
  }

  return (
    <div className="tab-pane" role="tabpanel">
      <div className="op-pane-head">
        <div className="op-pane-head-text">
          <h2 className="game-review-players">
            <span className={game.user_color === 'white' ? 'me' : ''}>{game.white}{whiteRating ? ` (${whiteRating})` : ''}</span>
            <span className="vs-sep">vs</span>
            <span className={game.user_color === 'black' ? 'me' : ''}>{game.black}{blackRating ? ` (${blackRating})` : ''}</span>
          </h2>
          <p>
            {opening}
            {game.time_class ? ` · ${game.time_class}` : ''}
            {game.date ? ` · ${game.date}` : ''}
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={onClose}>← Games</button>
      </div>

      <div className="game-review-result">
        <span className={`game-result ${pov || 'unknown'}`}>{pov ? POV_LABEL[pov] : (game.result || '?')}</span>
        <span className="game-review-score">{game.result || ''}</span>
        {chesscomUrl && (
          <a className="game-review-source" href={chesscomUrl}>Back to this game on chess.com</a>
        )}
      </div>

      {rows.length > 0 && onPlayFromHere && (
        <button type="button" className="btn-secondary game-review-play" onClick={onPlayFromHere}>
          Play on from this position against Stockfish
        </button>
      )}

      {rows.length ? (
        <div className="game-review-moves" ref={movesRef}>
          {rows.map((r) => (
            <div key={r.no} className="grm-row">
              <span className="grm-no">{r.no}.</span>
              {cell(r.w)}
              {cell(r.b)}
            </div>
          ))}
        </div>
      ) : (
        <div className="op-empty compact">
          <strong>No moves</strong>
          <p>This game&apos;s PGN couldn&apos;t be read.</p>
        </div>
      )}
    </div>
  )
}
