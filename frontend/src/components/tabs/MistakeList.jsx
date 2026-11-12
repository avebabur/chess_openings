import { ratingText } from '../../domain/practiceGoal'
import { moveLabel, opponentOf } from '../../hooks/useMistakes'

const BATCH = 4
const BIG_BATCH = 20
const MARK = { solved: '✓', failed: '✗' }
const MARK_LABEL = { solved: 'fixed', failed: 'missed last time' }

function resultWord(game) {
  if (game.result === '1/2-1/2') return 'draw'
  if (game.result !== '1-0' && game.result !== '0-1') return ''
  return (game.result === '1-0') === (game.user_color === 'white') ? 'win' : 'loss'
}

function JobBar({ job, data, onAnalyse, onStop }) {
  if (job?.running) {
    const current = Math.min(job.done + 1, job.total)
    return (
      <p className="practice-lib-import" role="status">
        Analysing game {current} of {job.total}{job.title ? ` (${job.title})` : ''}…
        About 20 seconds a game. You can keep using the app.{' '}
        <button type="button" className="btn-link" onClick={onStop}>Stop</button>
      </p>
    )
  }
  const left = data ? data.games_total - data.games_analysed : 0
  return (
    <>
      {job?.error && <p className="play-fen-error" role="alert">{job.error}</p>}
      {data && left === 0 && data.games_total > 0 && (
        <p className="practice-lib-import">All {data.games_total} of your games have been analysed.</p>
      )}
      {data && data.games_total === 0 && (
        <p className="practice-lib-import">Import an account from the account menu first.</p>
      )}
      {left > 0 && (
        <div className="mistake-actions">
          <button
            type="button"
            className={data.games_analysed ? 'btn-secondary' : 'btn-primary'}
            onClick={() => onAnalyse(BATCH)}
          >
            Analyse my {data.games_analysed ? 'next' : 'last'} {Math.min(BATCH, left)} game{left === 1 ? '' : 's'}
          </button>
          {left > BATCH && (
            <button type="button" className="btn-link" onClick={() => onAnalyse(BIG_BATCH)}>
              or {Math.min(BIG_BATCH, left)}
            </button>
          )}
          <span className="mistake-count">{data.games_analysed} of {data.games_total} analysed</span>
        </div>
      )}
    </>
  )
}

export default function MistakeList({ data, loadError, job, onAnalyse, onStop, onStart }) {
  const analysed = Boolean(data?.games_analysed)

  return (
    <section className="practice-lib" aria-label="Mistakes from your games">
      <div className="practice-lib-head">
        <div>
          <span className="eyebrow">Your games</span>
          <strong>
            {analysed ? `${data.solved} of ${data.total} mistakes fixed` : 'Replay your own mistakes'}
          </strong>
        </div>
      </div>

      {loadError && <p className="play-fen-error" role="alert">{loadError}</p>}

      {!analysed && !job?.running && (
        <p className="practice-lib-intro">
          Stockfish goes through your newest games and keeps every move that cost you at least
          a tenth of your winning chances. Each one becomes a one-move exercise: you get the
          position again and have to find something better than you played.
        </p>
      )}

      <JobBar job={job} data={data} onAnalyse={onAnalyse} onStop={onStop} />

      {(data?.games || []).map((game, index) => {
        const fixed = game.mistakes.filter(m => m.progress.last_result === 'solved').length
        const result = resultWord(game)
        return (
          <details className="practice-lib-set" key={game.id} open={index === 0}>
            <summary>
              <span className="practice-lib-set-title">
                vs {opponentOf(game)}
                <span className="mistake-game-meta">
                  {[result, game.time_class, game.date].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="practice-lib-set-count">{fixed}/{game.mistakes.length}</span>
            </summary>
            {game.mistakes.length === 0 ? (
              <p className="practice-lib-subtitle">No mistakes found in this game.</p>
            ) : (
              <ul>
                {game.mistakes.map((mistake) => {
                  const last = mistake.progress.last_result
                  return (
                    <li key={mistake.id}>
                      <button
                        type="button"
                        className={`practice-lib-pos ${last || ''}`}
                        onClick={() => onStart(mistake, game)}
                      >
                        <span className="practice-lib-mark" aria-hidden="true">{MARK[last] || ''}</span>
                        <span className="practice-lib-name">
                          {moveLabel(mistake.ply, mistake.played_san)}
                          <span className={`mistake-kind ${mistake.kind}`}>
                            {mistake.kind === 'blunder' ? '??' : '?'}
                          </span>
                        </span>
                        <span className="practice-lib-goal">
                          {ratingText(mistake.cp_before, mistake.source)} → {ratingText(mistake.cp_after, mistake.source)}
                        </span>
                        {last && <span className="visually-hidden"> ({MARK_LABEL[last]})</span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </details>
        )
      })}
    </section>
  )
}
