import { uciLineToSan } from '../domain/chessLine'
import {
  DEFAULT_TARGET,
  canSavePositionEval,
  targetIsDeeper,
  targetIsInfinite,
} from '../hooks/usePositionEval'
import {
  compactNum,
  evalToWhitePct,
  formatEval,
  lineMoves,
  pct,
  stockfishDepthLabel,
} from '../utils/formatUtils'
import ClickableMoveLine from './shared/ClickableMoveLine'
import ResultBar from './shared/ResultBar'

/** "Lichess rate-limited", plus the remaining backoff when the backend reports it. */
function rateLimitedText(state) {
  const s = state?.retry_after
  return s ? `Lichess rate-limited — retry in ${s}s` : 'Lichess rate-limited'
}

/** The exact HTTP code behind a generic cloud error, when the backend reports it
 *  (e.g. "Cloud unavailable (503)") — answers "403/429/503?" at a glance. */
function cloudErrorText(cloud) {
  return cloud?.status ? `Cloud unavailable (${cloud.status})` : 'Cloud unavailable'
}

/** Honest, distinct copy for each cloud state — never a permanent "busy". */
function cloudPlaceholder(cloud) {
  if (!cloud) return 'Loading…'
  switch (cloud.source) {
    case 'fetching': return 'Loading…'
    case 'miss': return 'Not in cloud database'
    case 'ratelimited': return rateLimitedText(cloud)
    case 'error': return cloudErrorText(cloud)
    default: return 'No cloud line here'
  }
}

/** Cloud eval is fetched on demand (Lichess is rate-limited): a never-fetched
 *  position ("unknown"), a failed one ("error"), or a rate-limited one offers a
 *  button to load/retry it. (A retry while rate-limited is harmless — the backend
 *  short-circuits during its cooldown without calling Lichess.) A brief null right
 *  after navigation reads "Loading…", not a button flash. */
function cloudCanFetch(cloud) {
  return cloud?.source === 'unknown' || cloud?.source === 'error'
    || cloud?.source === 'ratelimited'
}

/** Left-hand status text shown next to the load/retry button. */
function cloudFetchLabel(cloud) {
  if (cloud?.source === 'ratelimited') return rateLimitedText(cloud)
  if (cloud?.source === 'error') return cloudErrorText(cloud)
  return 'Not loaded'
}

/** Honest copy for each explorer state — mirrors cloudPlaceholder. */
function explorerPlaceholder(explorer) {
  if (!explorer) return 'Loading…'
  switch (explorer.source) {
    case 'ratelimited': return rateLimitedText(explorer)
    case 'auth_required': return 'Lichess requires a token'
    case 'error': return 'Explorer unavailable'
    default: return 'No games in this position'
  }
}

function EvalBar({ value }) {
  const whitePct = evalToWhitePct(value)
  return (
    <div className="op-evalbar" role="img" aria-label="Position evaluation">
      <span className="op-evalbar-fill" style={{ width: `${whitePct}%` }} />
    </div>
  )
}

function EngineLineRow({ moves, score, scoreClass = '', searching = false, onSelect, placeholder }) {
  const interactive = Boolean(moves?.length && onSelect)
  return (
    <div className={`op-line${searching ? ' searching' : ''}${interactive ? '' : ' static'}`}>
      <span className={`op-line-eval ${scoreClass}`.trim()}>{score}</span>
      {moves?.length ? (
        <ClickableMoveLine moves={moves} onSelect={onSelect} className="op-line-moves" />
      ) : (
        <span className="op-line-moves muted">{placeholder}</span>
      )}
    </div>
  )
}

/** Eval bar + Stockfish and Lichess lines for the Explore tab. */
export default function EnginePanel({
  fen, localEval, cloud, explorer, sideToMove, target: targetProp,
  stockfish,
  actionError,
  onLineSelect, onConfigureToken, onFetchCloud,
  onDeepen, onShallow, onGoInfinite, onResetDepth, onFreeze, onSaveEval, onClearSaved,
}) {
  const target = targetProp ?? DEFAULT_TARGET
  const searching = Boolean(localEval?.searching)
  const sfLines = localEval?.lines || []
  const sfEval = localEval?.eval
  const sfBest = localEval?.best_move
  const isInfinite = targetIsInfinite(target)
  const deeperThanDefault = targetIsDeeper(target)
  const shallowerThanTarget = deeperThanDefault
  const isSaved = Boolean(localEval?.saved)
  const canSave = Boolean(onSaveEval && !isSaved && canSavePositionEval(localEval))
  const cloudIsLichess = cloud?.source === 'lichess'
  const cloudLines = cloudIsLichess
    ? (cloud.pvs || []).slice(0, 3).map((pv) => ({
        score: pv.eval?.mate != null
          ? `#${pv.eval.mate}`
          : pv.eval?.pawns != null ? formatEval(pv.eval.pawns) : '…',
        moves: uciLineToSan(fen, (pv.moves || '').split(' ')),
      }))
    : []

  const headlineEval = sfEval != null
    ? sfEval
    : (cloudIsLichess && cloud.eval?.pawns != null ? cloud.eval.pawns : null)
  const headlineText = localEval?.error
    ? '—'
    : headlineEval != null ? formatEval(headlineEval) : '…'
  const advantage = headlineEval == null ? '' : headlineEval > 0.4 ? ' white' : headlineEval < -0.4 ? ' black' : ''

  const explorerLines = explorer?.source === 'lichess' ? (explorer.moves || []) : []
  const explorerTotal = explorer?.total || 0
  const stockfishUnavailable = stockfish?.available === false

  return (
    <div className="op-engine">
      <div className="op-engine-head">
        <EvalBar value={headlineEval} />
        <div className="op-engine-readout">
          <span className="op-engine-side">{sideToMove} to move</span>
          <span className={`op-engine-score${advantage}`}>{headlineText}</span>
        </div>
      </div>

      <div className="op-engine-section sf">
        <div className="op-engine-section-head">
          <span className="op-engine-source">
            {(sfBest || sfLines.length) ? <span className="op-arrow-key sf" aria-hidden="true">→</span> : null}
            Stockfish
            {isSaved ? (
              <span className="op-saved-badge" title="Saved deep eval — auto-loaded, no cloud call">
                saved d{localEval.saved_depth ?? localEval.depth} ✓
              </span>
            ) : null}
          </span>
          <span className="op-engine-controls">
            <span className={`op-line-depth${searching ? ' searching' : ''}`}>
              {stockfishDepthLabel(localEval?.depth, target, searching)}
            </span>
            {!stockfishUnavailable && onDeepen && !isInfinite ? (
              <button type="button" className="op-depth-btn" title="Search longer (= / +)" aria-label="Search longer" onClick={onDeepen}>+</button>
            ) : null}
            {onShallow && shallowerThanTarget ? (
              <button type="button" className="op-depth-btn" title="Search shorter (-)" aria-label="Search shorter" onClick={onShallow}>−</button>
            ) : null}
            {!stockfishUnavailable && onGoInfinite && !isInfinite ? (
              <button type="button" className="op-depth-btn" title="Search until you stop / navigate away" aria-label="Search indefinitely" onClick={onGoInfinite}>∞</button>
            ) : null}
            {onFreeze && searching && (isInfinite || deeperThanDefault) ? (
              <button type="button" className="op-depth-btn" title="Stop at current depth (0) — finishes this depth, then save" aria-label="Stop at current depth" onClick={onFreeze}>Stop</button>
            ) : null}
            {canSave ? (
              <button type="button" className="op-depth-btn" title="Save this eval — reused on future visits" aria-label="Save evaluation" onClick={onSaveEval}>Save</button>
            ) : null}
            {onResetDepth && deeperThanDefault ? (
              <button type="button" className="op-depth-btn" title="Stop and return to 4s" aria-label="Reset analysis time" onClick={onResetDepth}>⟲</button>
            ) : null}
            {onClearSaved && isSaved ? (
              <button type="button" className="op-depth-btn" title="Clear the saved eval" aria-label="Clear saved evaluation" onClick={onClearSaved}>Clear</button>
            ) : null}
          </span>
        </div>
        {sfLines.length ? (
          sfLines.map((line, i) => (
            <EngineLineRow
              key={`sf-${i}`}
              moves={lineMoves(line)}
              score={line.eval != null ? formatEval(line.eval) : '…'}
              searching={searching}
              onSelect={onLineSelect}
            />
          ))
        ) : (
          <EngineLineRow
            moves={sfBest ? [sfBest] : null}
            score={sfEval != null ? formatEval(sfEval) : '…'}
            searching={searching}
            onSelect={onLineSelect}
            placeholder={stockfishUnavailable
              ? (stockfish.message || 'Install Stockfish or set STOCKFISH_PATH')
              : localEval?.error ? 'Engine unavailable' : searching ? 'Searching…' : 'No engine line here'}
          />
        )}
        {actionError ? <span className="op-line-moves muted" role="alert">{actionError}</span> : null}
      </div>

      <div className="op-engine-section cloud">
        <div className="op-engine-section-head">
          <span className="op-engine-source cloud">
            {cloudLines.length ? <span className="op-arrow-key cloud" aria-hidden="true">→</span> : null}
            Lichess cloud
          </span>
          {cloud?.depth ? <span className="op-line-depth cloud">d{cloud.depth}</span> : null}
        </div>
        {cloudLines.length ? (
          cloudLines.map((line, i) => (
            <EngineLineRow
              key={`cl-${i}`}
              moves={line.moves}
              score={line.score}
              scoreClass="cloud"
              onSelect={onLineSelect}
            />
          ))
        ) : cloudCanFetch(cloud) && onFetchCloud ? (
          <div className="op-cloud-fetch">
            <span className="op-line-moves muted">{cloudFetchLabel(cloud)}</span>
            <button type="button" className="op-cloud-load-btn" onClick={onFetchCloud}>
              {cloud?.source === 'unknown' ? 'Get cloud eval' : 'Retry'}
            </button>
          </div>
        ) : (
          <EngineLineRow
            moves={null}
            score="…"
            scoreClass="cloud muted"
            placeholder={cloudPlaceholder(cloud)}
          />
        )}
      </div>

      <div className="op-engine-section players">
        <div className="op-engine-section-head">
          <span className="op-engine-source explorer">
            {explorerLines.length ? <span className="op-arrow-key explorer" aria-hidden="true">→</span> : null}
            Lichess players
          </span>
          {explorerTotal > 0
            ? <span className="op-line-depth explorer">
              {compactNum(explorerTotal)} games{explorer?.stale_error ? ' · offline data' : ''}
            </span>
            : null}
        </div>
        {explorerLines.length ? (
          <div className="op-explorer-moves">
            {explorerLines.map((m) => {
              const wPct = pct((m.white / m.games) * 100)
              const dPct = pct((m.draws / m.games) * 100)
              const lPct = pct((m.black / m.games) * 100)
              return (
                <button
                  key={m.uci || m.san}
                  type="button"
                  className="op-explorer-row"
                  onClick={() => onLineSelect?.([m.san])}
                  title={`Play ${m.san} — ${compactNum(m.games)} games`}
                >
                  <span className="oe-san">{m.san}</span>
                  <span className="oe-games">{compactNum(m.games)}</span>
                  <span className="oe-bar">
                    <ResultBar
                      win={m.white}
                      draw={m.draws}
                      loss={m.black}
                      games={m.games}
                      scheme="players"
                      title={`White ${wPct} · Draw ${dPct} · Black ${lPct}`}
                    />
                  </span>
                  <span className="oe-draw" title={`Draws ${dPct}`}>
                    <i className="oe-dot" />{dPct}
                  </span>
                </button>
              )
            })}
          </div>
        ) : explorer?.source === 'auth_required' ? (
          <div className="op-explorer-auth">
            <span className="op-line-moves muted">
              Lichess now requires a token for the players explorer.
            </span>
            {onConfigureToken && (
              <button type="button" className="op-explorer-token-btn" onClick={onConfigureToken}>
                {explorer.has_token ? 'Update token' : 'Add token'}
              </button>
            )}
          </div>
        ) : (
          <div className="op-line static">
            <span className="op-line-eval muted">…</span>
            <span className="op-line-moves muted">{explorerPlaceholder(explorer)}</span>
          </div>
        )}
      </div>
    </div>
  )
}
