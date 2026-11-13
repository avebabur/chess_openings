import { useState } from 'react'
import {
  MAX_THINK_SECONDS,
  MIN_THINK_SECONDS,
  PLAY_STATUS,
  clampSeconds,
  goalEnded,
  latestVerdict,
  pieceCount,
  playFen,
  resultText,
  tablebaseCovers,
} from '../../domain/playSession'
import { describeGoal, goalOutcomeText, isPlayableGoal } from '../../domain/practiceGoal'
import PracticeLibrary from './PracticeLibrary'
import MistakeList from './MistakeList'
import PuzzlePanel from './PuzzlePanel'

const THINK_TIMES = [1, 3, 10, 30]

/**
 * How long Stockfish thinks per move: a few presets, or any number of seconds.
 * The same control sits on the setup screen and in a running game, where a
 * change applies from the engine's next move.
 */
function ThinkTime({ id, seconds, onChange }) {
  const [text, setText] = useState(String(seconds))
  // Follow a change made elsewhere (a preset, or the other copy of the control).
  const [shown, setShown] = useState(seconds)
  if (shown !== seconds) {
    setShown(seconds)
    setText(String(seconds))
  }
  const commit = () => {
    const value = clampSeconds(text)
    setText(String(value))
    if (value !== seconds) onChange(value)
  }
  return (
    <div className="play-setup-row">
      <span className="eyebrow" id={`${id}-label`}>Stockfish thinking time</span>
      <div className="think-time">
        <div className="seg" role="group" aria-labelledby={`${id}-label`}>
          {THINK_TIMES.map(value => (
            <button
              key={value}
              type="button"
              className={seconds === value ? 'on' : ''}
              aria-pressed={seconds === value}
              onClick={() => onChange(value)}
            >
              {value}s
            </button>
          ))}
        </div>
        <label className="think-custom">
          <input
            type="number"
            inputMode="decimal"
            min={MIN_THINK_SECONDS}
            max={MAX_THINK_SECONDS}
            step="any"
            value={text}
            onChange={event => setText(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
            aria-label="Custom thinking time in seconds"
          />
          <span>sec</span>
        </label>
      </div>
    </div>
  )
}

function colorName(color) {
  return color === 'white' ? 'White' : 'Black'
}

/** One sentence on what the tablebase made of the user's last move. */
function verdictCopy(verdict) {
  const fifty = verdict.fiftyMove ? ' (only because of the 50-move rule)' : ''
  switch (verdict.kind) {
    case 'kept-win': {
      const mate = verdict.mateIn != null ? `, mate in ${verdict.mateIn}` : ''
      const faster = verdict.fastest === false && verdict.fastestSan
        ? ` ${verdict.fastestSan} was quicker (mate in ${verdict.fastestMateIn}).`
        : ''
      return { tone: 'good', title: `${verdict.san} keeps the win`, body: `Still winning${mate}.${faster}` }
    }
    case 'kept-draw':
      return { tone: 'good', title: `${verdict.san} holds the draw`, body: `Still a draw${fifty}.` }
    case 'lost-anyway':
      return { tone: 'neutral', title: `${verdict.san}`, body: 'The position was already lost. No move saves it.' }
    case 'win-to-draw':
      return {
        tone: 'bad',
        title: `${verdict.san} throws away the win`,
        body: `It is now a draw${fifty}. ${verdict.bestSan} was winning.`,
      }
    case 'win-to-loss':
      return {
        tone: 'bad',
        title: `${verdict.san} turns a win into a loss`,
        body: `${verdict.bestSan} was winning.`,
      }
    case 'draw-to-loss':
      return {
        tone: 'bad',
        title: `${verdict.san} loses`,
        body: `${verdict.bestSan} held the draw.`,
      }
    default:
      return null
  }
}

export default function PlayTab({
  session,
  positionTitle,
  positionFen,
  positionOver,
  fenDraft,
  fenError,
  usingPastedFen,
  onFenDraftChange,
  onStart,
  onTakeBack,
  onRestart,
  onExit,
  onRetry,
  practice,
  onStartPractice,
  onNextPractice,
  mistakes,
  onStartMistake,
  puzzles,
  onStartPuzzles,
  onRetryPuzzle,
  onPlayOn,
  onSetSeconds,
}) {
  const [seconds, setSeconds] = useState(THINK_TIMES[0])

  // --- Setup screen ---
  if (!session) {
    const toMove = positionFen.split(' ')[1] === 'b' ? 'black' : 'white'
    const pieces = pieceCount(positionFen)
    const covered = tablebaseCovers(positionFen)
    return (
      <div className="tab-pane" role="tabpanel">
        <div className="op-pane-head">
          <div className="op-pane-head-text">
            <h2>Play against Stockfish</h2>
            <p>
              Play the position on the board against the engine. Reach one in Explore,
              open one of your games, or paste a position below.
            </p>
          </div>
        </div>

        <MistakeList
          data={mistakes.data}
          loadError={mistakes.loadError}
          job={mistakes.job}
          onAnalyse={mistakes.start}
          onStop={mistakes.stop}
          onStart={onStartMistake}
          onPractiseTheme={onStartPuzzles}
        />

        <PuzzlePanel puzzles={puzzles} onStart={onStartPuzzles} onRetry={onRetryPuzzle} />

        <PracticeLibrary
          library={practice.library}
          loadError={practice.loadError}
          importState={practice.importState}
          onImport={practice.startImport}
          onStart={onStartPractice}
        />

        <div className="practice-card">
          <span className="eyebrow">{usingPastedFen ? 'Pasted position' : 'Position from Explore'}</span>
          <strong>{usingPastedFen ? 'Shown on the board' : positionTitle}</strong>
          <p>
            {colorName(toMove)} to move · {pieces} pieces.{' '}
            {covered
              ? 'Every move you make will be checked against the endgame tablebase.'
              : 'Tablebase verdicts begin once 7 or fewer pieces are left.'}
          </p>
        </div>

        <label className="play-fen">
          <span className="eyebrow">Or paste a position (FEN)</span>
          <input
            type="text"
            value={fenDraft}
            onChange={event => onFenDraftChange(event.target.value)}
            placeholder="6K1/4k1P1/8/8/8/7r/8/5R2 w - - 0 1"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={Boolean(fenError)}
            aria-describedby={fenError ? 'play-fen-error' : undefined}
          />
        </label>
        {fenError && <p className="play-fen-error" id="play-fen-error" role="alert">{fenError}</p>}
        {fenDraft && (
          <button type="button" className="btn-link" onClick={() => onFenDraftChange('')}>
            Clear and use the Explore position
          </button>
        )}

        <ThinkTime id="play-think-setup" seconds={seconds} onChange={setSeconds} />

        {fenError ? null : positionOver ? (
          <div className="op-empty compact">
            <strong>This position is already over</strong>
            <p>Go back a move in Explore to play from an earlier position.</p>
          </div>
        ) : (
          <div className="practice-done-actions">
            {['white', 'black'].map(side => (
              <button
                key={side}
                type="button"
                className={side === toMove ? 'btn-primary' : 'btn-secondary'}
                onClick={() => onStart({ userColor: side, seconds })}
              >
                Play as {colorName(side)}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // --- Game in progress ---
  const { status, error, userColor } = session
  const verdict = latestVerdict(session)
  const copy = verdict ? verdictCopy(verdict) : null
  const fen = playFen(session)
  const userMoves = session.moves.filter(move => move.by === 'user').length
  const lastEngine = session.moves.at(-1)?.by === 'engine' ? session.moves.at(-1) : null
  const goal = isPlayableGoal(session.goal) ? session.goal : null
  const goalText = goal ? describeGoal(goal) : null
  const ended = goalEnded(session)
  const outcome = ended ? goalOutcomeText(goal, session.goalState) : null
  const isPuzzle = goal?.kind === 'puzzle'
  // Exercises with a fixed answer; the tablebase note would only distract.
  const fixedAnswer = isPuzzle || goal?.kind === 'better'
  const nextLabel = isPuzzle ? 'Next puzzle' : 'Next position'

  return (
    <div className="tab-pane" role="tabpanel">
      <div className="practice-session">
        <div className="practice-header">
          <div>
            <span className="eyebrow">Playing as {colorName(userColor)}</span>
            <strong>{session.label || 'Against Stockfish'}</strong>
          </div>
          <button type="button" className="btn-secondary" onClick={onExit}>Exit</button>
        </div>

        {goalText && (
          <div className="practice-card" aria-label="Goal">
            <span className="eyebrow">Goal</span>
            <strong>{goalText.title}</strong>
            <p>{goalText.detail}</p>
            {goal.moves && (
              <p className="practice-goal-progress">
                Moves used: {Math.min(session.goalState?.used ?? 0, goal.moves)} of {goal.moves}
              </p>
            )}
          </div>
        )}

        {outcome && (
          <div
            className={`practice-card ${session.goalState.state === 'solved' ? 'success' : 'miss'}`}
            role="status"
            aria-label="Goal result"
          >
            <strong>{outcome.title}</strong>
            {outcome.body && <p>{outcome.body}</p>}
            {isPuzzle && (
              <details className="puzzle-answer">
                <summary>{session.goalState.state === 'solved' ? 'The whole line' : 'Show the answer'}</summary>
                <p>{goal.solutionSan.join(' ')}</p>
                <p>
                  {goal.themes.length ? `Themes: ${goal.themes.join(', ')}. ` : ''}
                  <a href={goal.url} target="_blank" rel="noreferrer">This puzzle on Lichess</a>
                </p>
              </details>
            )}
            <div className="practice-done-actions">
              {session.goalState.state === 'solved' && onNextPractice && (
                <button type="button" className="btn-primary" onClick={onNextPractice}>{nextLabel}</button>
              )}
              <button
                type="button"
                className={session.goalState.state === 'solved' ? 'btn-secondary' : 'btn-primary'}
                onClick={onRestart}
              >
                Try again
              </button>
              {session.goalState.state !== 'solved' && onNextPractice && (
                <button type="button" className="btn-secondary" onClick={onNextPractice}>
                  {isPuzzle ? 'Next puzzle' : 'Skip to next'}
                </button>
              )}
              {!session.result && (
                <button type="button" className="btn-secondary" onClick={onPlayOn}>
                  Play on against Stockfish
                </button>
              )}
              <button type="button" className="btn-secondary" onClick={onExit}>Back to library</button>
            </div>
          </div>
        )}

        {status === PLAY_STATUS.USER_TURN && (
          <div className="practice-card active" role="status">
            <strong>Your move</strong>
            <p>
              {lastEngine
                ? lastEngine.source === 'script'
                  ? `The reply was ${lastEngine.san}. Keep going.`
                  : `Stockfish played ${lastEngine.san}${lastEngine.source === 'tablebase' ? ' (tablebase)' : ''}.`
                : `You are ${colorName(userColor)}.`}
            </p>
          </div>
        )}

        {status === PLAY_STATUS.ENGINE_THINKING && !error && !session.script && (
          <div className="practice-card" role="status">
            <strong>Stockfish is thinking…</strong>
            <p>You can queue your next move now. It is played if it is still legal.</p>
          </div>
        )}

        {error && (
          <div className="review-write-error" role="alert">
            <span>{error}</span>
            <button type="button" className="btn-secondary" onClick={onRetry}>Retry</button>
          </div>
        )}

        {status === PLAY_STATUS.OVER && !outcome && (
          <div className={`practice-card ${session.result?.winner === userColor ? 'success' : ''}`} role="status">
            <strong>{resultText(session)}</strong>
            <p>{userMoves} move{userMoves === 1 ? '' : 's'} played.</p>
          </div>
        )}

        {copy && (
          <div className={`practice-card play-verdict ${copy.tone}`} role="status" aria-label="Tablebase verdict">
            <span className="eyebrow">Tablebase</span>
            <strong>{copy.title}</strong>
            <p>{copy.body}</p>
          </div>
        )}

        {!copy && !fixedAnswer && status !== PLAY_STATUS.OVER && !tablebaseCovers(fen) && (
          <p className="play-note">
            {pieceCount(fen) > 7
              ? `Tablebase verdicts begin at 7 pieces. There are ${pieceCount(fen)} now.`
              : 'The tablebase does not cover positions that still have castling rights.'}
          </p>
        )}

        {!session.script && status !== PLAY_STATUS.OVER && (
          <ThinkTime id="play-think-game" seconds={session.seconds} onChange={onSetSeconds} />
        )}

        {!outcome && (
          <div className="practice-done-actions">
            <button type="button" className="btn-secondary" onClick={onTakeBack} disabled={!userMoves}>
              Take back
            </button>
            <button type="button" className="btn-secondary" onClick={onRestart} disabled={!session.moves.length}>
              Restart
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
