import { useState } from 'react'
import { pct } from '../../utils/formatUtils'
import ResultBar from '../shared/ResultBar'

export default function ExploreTab({
  sideToMove,
  path,
  currentLineTitle,
  saveTarget,
  summary,
  loading,
  error,
  moves,
  directGames = 0,
  transpositions = [],
  onSave,
  onPlayMove,
  onJumpToPath,
  onReload,
}) {
  const [ordersOpen, setOrdersOpen] = useState(false)
  // Games that got here by a move order other than the one on the board. The
  // whole point of keying the tree on positions rather than move paths.
  const transposedGames = Math.max(0, (summary?.games || 0) - directGames)

  return (
    <div className="tab-pane" role="tabpanel">
      <div className="op-pane-head">
        <div className="op-pane-head-text">
          <h2>{sideToMove} to move</h2>
          <p>{path.length ? currentLineTitle : 'Pick a first move from your games, or play on the board.'}</p>
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={!path.length}
          onClick={onSave}
          title={path.length ? 'Save this line to your repertoire' : 'Play a move first'}
        >
          {saveTarget ? 'Update' : 'Save line'}
        </button>
      </div>

      <div className="op-statline">
        <div className="op-stat">
          <span className="op-stat-label">Games here</span>
          <span className="op-stat-num">{summary ? summary.games.toLocaleString() : loading ? '…' : '0'}</span>
          {transposedGames > 0 && (
            <span className="op-stat-sub">{directGames} direct · {transposedGames} transposed</span>
          )}
        </div>
        <div className="op-stat">
          <span className="op-stat-label">Your score</span>
          <span className={`op-stat-num${summary?.games ? (summary.score >= 55 ? ' good' : summary.score <= 45 ? ' bad' : '') : ''}`}>
            {summary?.games ? pct(summary.score) : '—'}
          </span>
        </div>
        <div className="op-stat">
          <span className="op-stat-label">Replies</span>
          <span className="op-stat-num">{loading && !moves.length ? '…' : moves.length}</span>
        </div>
      </div>

      {summary?.games > 0 && (
        <div className="op-wdl-summary">
          <ResultBar win={summary.win} draw={summary.draw} loss={summary.loss} games={summary.games} />
          <div className="op-wdl-legend">
            <span><i className="dot win" /> {summary.win}W</span>
            <span><i className="dot draw" /> {summary.draw}D</span>
            <span><i className="dot loss" /> {summary.loss}L</span>
          </div>
        </div>
      )}

      {transpositions.length > 0 && (
        <div className="op-transpositions">
          <button
            type="button"
            className="op-transpositions-toggle"
            aria-expanded={ordersOpen}
            onClick={() => setOrdersOpen(open => !open)}
          >
            <span className={`op-caret${ordersOpen ? ' open' : ''}`} aria-hidden="true" />
            Also reached via {transpositions.length} other move order{transpositions.length === 1 ? '' : 's'}
          </button>
          {ordersOpen && (
            <ul className="op-transposition-list">
              {transpositions.map(order => (
                <li key={order.path_san}>
                  <button type="button" onClick={() => onJumpToPath(order.path)}>
                    <span className="op-transposition-moves">{order.path_san}</span>
                    <span className="op-transposition-games">{order.games}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error ? (
        <div className="op-empty">
          <strong>Could not load this position</strong>
          <p>The stats service didn&apos;t respond. Check the backend, then retry.</p>
          <button type="button" className="btn-secondary" onClick={onReload}>Retry</button>
        </div>
      ) : loading && !moves.length ? (
        <div className="moves-skel">{[0, 1, 2, 3, 4].map(i => <div key={i} className="skel-row" />)}</div>
      ) : moves.length ? (
        <div className="move-table">
          <div className="moves-head">
            <span>#</span>
            <span>Move</span>
            <span>Games</span>
            <span>Results</span>
            <span>Score</span>
          </div>
          {moves.map((m, i) => (
            <button
              key={m.san}
              type="button"
              className="move-row"
              title={`Play ${m.san} — ${m.games} game${m.games === 1 ? '' : 's'}${
                m.transposed_games > 0 ? `, ${m.total_games} counting transpositions` : ''
              }`}
              onClick={() => onPlayMove(m.san)}
            >
              <span className="mr-rank">{i + 1}</span>
              <span className="mr-san">{m.san}</span>
              <span className="mr-games">
                <i><b style={{ width: `${m.share}%` }} /></i>
                <em>{m.games}</em>
                {m.transposed_games > 0 && (
                  <em
                    className="mr-games-total"
                    title={`${m.total_games} games reached this position, ${m.transposed_games} by another move order`}
                  >
                    →{m.total_games}
                  </em>
                )}
              </span>
              <span className="mr-results">
                <ResultBar win={m.win} draw={m.draw} loss={m.loss} games={m.games} compact />
              </span>
              <span className={`mr-score ${m.score >= 55 ? 'good' : m.score <= 45 ? 'bad' : ''}`}>
                {pct(m.score)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="op-empty">
          <strong>No games reached this position</strong>
          <p>Try a different time control, or play moves on the board to explore further.</p>
        </div>
      )}
    </div>
  )
}
