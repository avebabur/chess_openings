/** Result from the user's point of view → 'win' | 'draw' | 'loss' | null. */
function resultPov(result, userColor) {
  if (result === '1/2-1/2') return 'draw'
  if (userColor !== 'white' && userColor !== 'black') return null
  if (result === '1-0') return userColor === 'white' ? 'win' : 'loss'
  if (result === '0-1') return userColor === 'black' ? 'win' : 'loss'
  return null
}

const POV_LABEL = { win: 'W', draw: 'D', loss: 'L' }

export default function GamesTab({
  games,
  total,
  loading,
  error,
  hasMore,
  accountName,
  onOpenGame,
  onLoadMore,
  onReload,
}) {
  return (
    <div className="tab-pane" role="tabpanel">
      <div className="op-pane-head">
        <div className="op-pane-head-text">
          <h2>{total ? `${total.toLocaleString()} game${total === 1 ? '' : 's'}` : loading ? 'Loading…' : 'No games'}</h2>
          <p>{accountName ? `${accountName} · newest first` : 'Click a game to review it move by move.'}</p>
        </div>
      </div>

      {error ? (
        <div className="op-empty">
          <strong>Could not load games</strong>
          <p>The games service didn&apos;t respond. Check the backend, then retry.</p>
          <button type="button" className="btn-secondary" onClick={onReload}>Retry</button>
        </div>
      ) : loading && !games.length ? (
        <div className="moves-skel">{[0, 1, 2, 3, 4, 5].map(i => <div key={i} className="skel-row" />)}</div>
      ) : games.length ? (
        <>
          <div className="item-list game-list">
            {games.map((g) => {
              const pov = resultPov(g.result, g.user_color)
              const opponent = g.user_color === 'white' ? g.black : g.white
              const opening = g.opening || g.eco || 'Unknown opening'
              return (
                <button
                  key={g.id}
                  type="button"
                  className="item-row game-row"
                  onClick={() => onOpenGame(g)}
                  title="Open this game for review"
                >
                  <span className={`game-result ${pov || 'unknown'}`}>
                    {pov ? POV_LABEL[pov] : (g.result || '?')}
                  </span>
                  <span className="game-main">
                    <span className="game-vs">
                      <i className={`piece-dot ${g.user_color || 'white'}`} aria-hidden="true" />
                      vs {opponent || 'Unknown'}
                    </span>
                    <span className="item-detail">{opening}</span>
                  </span>
                  <span className="game-meta">
                    {g.time_class ? <span className="game-tc">{g.time_class}</span> : null}
                    {g.user_rating || g.opp_rating
                      ? <span className="game-ratings">{g.user_rating ?? '?'} vs {g.opp_rating ?? '?'}</span>
                      : null}
                    {g.date ? <span className="game-date">{g.date}</span> : null}
                  </span>
                </button>
              )
            })}
          </div>
          {hasMore && (
            <button
              type="button"
              className="btn-secondary game-load-more"
              onClick={onLoadMore}
              disabled={loading}
            >
              {loading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      ) : (
        <div className="op-empty">
          <strong>No games yet</strong>
          <p>Import an account from the account menu to browse your games here.</p>
        </div>
      )}
    </div>
  )
}
