import { goalLabel } from '../../domain/practiceGoal'

const MARK = { solved: '✓', failed: '✗' }
const MARK_LABEL = { solved: 'solved', failed: 'missed last time' }

function ImportBar({ importState, onImport, imported }) {
  const running = importState?.running
  if (running) {
    const { done = 0, total = 0, title = '' } = importState
    return (
      <p className="practice-lib-import" role="status">
        Importing from Lichess… {total ? `${done} of ${total} sets` : 'reading the index'}
        {title ? ` (${title})` : ''}. Lichess allows one request at a time, so this takes a few minutes.
      </p>
    )
  }
  return (
    <>
      {importState?.error && <p className="play-fen-error" role="alert">{importState.error}</p>}
      {importState?.result?.failed?.length > 0 && (
        <p className="play-fen-error" role="alert">
          {importState.result.failed.length} set(s) did not download: {importState.result.failed.join(', ')}.
          Update again to retry them.
        </p>
      )}
      <button type="button" className={imported ? 'btn-link' : 'btn-primary'} onClick={onImport}>
        {imported ? 'Update from Lichess' : 'Import the Lichess Practice sets'}
      </button>
    </>
  )
}

export default function PracticeLibrary({ library, loadError, importState, onImport, onStart }) {
  const imported = Boolean(library?.imported)

  return (
    <section className="practice-lib" aria-label="Lichess Practice library">
      <div className="practice-lib-head">
        <div>
          <span className="eyebrow">Lichess Practice</span>
          <strong>{imported ? `${library.solved} of ${library.total} solved` : 'Practice positions with a goal'}</strong>
        </div>
      </div>

      {loadError && <p className="play-fen-error" role="alert">{loadError}</p>}

      {!imported && !importState?.running && (
        <p className="practice-lib-intro">
          Lichess has 32 practice sets: checkmates, tactics, pawn endings and rook endings.
          Import them once and you can play any position here against Stockfish, with the goal
          checked for you. Nothing is sent to Lichess except the download itself.
        </p>
      )}

      <ImportBar importState={importState} onImport={onImport} imported={imported} />

      {imported && library.sections.map(section => (
        <div className="practice-lib-section" key={section.id}>
          <h3>
            {section.title}
            <span>{section.solved}/{section.total}</span>
          </h3>
          {section.sets.map(set => (
            <details className="practice-lib-set" key={set.id}>
              <summary>
                <span className="practice-lib-set-title">{set.title}</span>
                <span className="practice-lib-set-count">{set.solved}/{set.total}</span>
              </summary>
              {set.subtitle && <p className="practice-lib-subtitle">{set.subtitle}</p>}
              <ul>
                {set.positions.map(position => {
                  const result = position.progress.last_result
                  return (
                    <li key={position.id}>
                      <button
                        type="button"
                        className={`practice-lib-pos ${result || ''}`}
                        onClick={() => onStart({ ...position, setTitle: set.title })}
                      >
                        <span className="practice-lib-mark" aria-hidden="true">{MARK[result] || ''}</span>
                        <span className="practice-lib-name">{position.name}</span>
                        <span className="practice-lib-goal">{goalLabel(position.goal)}</span>
                        {result && <span className="visually-hidden"> ({MARK_LABEL[result]})</span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </details>
          ))}
        </div>
      ))}
    </section>
  )
}
