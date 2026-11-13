import { themeLabels } from '../../hooks/usePuzzles'

const DIFFICULTY_LABEL = {
  easiest: 'Easiest', easier: 'Easier', normal: 'Normal', harder: 'Harder', hardest: 'Hardest',
}
// Lichess rates an anonymous request around 1500 and shifts it by difficulty.
const DIFFICULTY_RATING = { easiest: 900, easier: 1200, normal: 1500, harder: 1800, hardest: 2100 }

export default function PuzzlePanel({ puzzles, onStart, onRetry }) {
  const { summary, choice, setChoice, loading, error } = puzzles
  const labels = themeLabels(summary)
  const missed = summary?.missed || []

  return (
    <section className="practice-lib" aria-label="Lichess puzzles">
      <div className="practice-lib-head">
        <div>
          <span className="eyebrow">Lichess puzzles</span>
          <strong>
            {summary?.played
              ? `${summary.solved} of ${summary.played} solved on the first try`
              : 'Puzzles by theme'}
          </strong>
        </div>
      </div>

      <p className="practice-lib-intro">
        One puzzle at a time from Lichess, on any of its themes. The solution is checked here,
        and the ones you miss are kept below to try again.
      </p>

      <div className="puzzle-controls">
        <label className="puzzle-theme">
          <span className="eyebrow">Theme</span>
          <select
            value={choice.theme}
            onChange={event => setChoice({ theme: event.target.value })}
            disabled={!summary}
          >
            {(summary?.groups || []).map(group => (
              <optgroup key={group.title} label={group.title}>
                {group.themes.map(theme => (
                  <option key={theme.key} value={theme.key}>
                    {theme.label}{theme.played ? ` (${theme.solved}/${theme.played})` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="puzzle-theme">
          <span className="eyebrow">Difficulty</span>
          <select
            value={choice.difficulty}
            onChange={event => setChoice({ difficulty: event.target.value })}
            disabled={!summary}
          >
            {(summary?.difficulties || []).map(value => (
              <option key={value} value={value}>
                {DIFFICULTY_LABEL[value] || value} (about {DIFFICULTY_RATING[value]})
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="practice-lib-subtitle">Ratings are on Lichess&apos;s puzzle scale.</p>

      {error && <p className="play-fen-error" role="alert">{error}</p>}

      <button type="button" className="btn-primary" onClick={onStart} disabled={loading || !summary}>
        {loading ? 'Getting a puzzle…' : 'Start puzzles'}
      </button>

      {missed.length > 0 && (
        <details className="practice-lib-set puzzle-missed">
          <summary>
            <span className="practice-lib-set-title">Missed puzzles</span>
            <span className="practice-lib-set-count">{missed.length}</span>
          </summary>
          <ul>
            {missed.map(puzzle => (
              <li key={puzzle.id}>
                <button type="button" className="practice-lib-pos failed" onClick={() => onRetry(puzzle)}>
                  <span className="practice-lib-mark" aria-hidden="true">✗</span>
                  <span className="practice-lib-name">{labels[puzzle.theme] || puzzle.theme}</span>
                  <span className="practice-lib-goal">rated {puzzle.rating}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
