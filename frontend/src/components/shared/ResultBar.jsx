import { pct } from '../../utils/formatUtils'

export default function ResultBar({ win, draw, loss, games, compact = false, scheme = 'result', title }) {
  const variant = `${compact ? ' compact' : ''}${scheme === 'players' ? ' players' : ''}`
  if (!games) return <div className={`wdl-bar empty${variant}`} />
  const w = (win / games) * 100
  const d = (draw / games) * 100
  const l = (loss / games) * 100
  return (
    <div className={`wdl-bar${variant}`} title={title ?? `${win}W / ${draw}D / ${loss}L`}>
      {w > 0 && <span className="wdl win" style={{ width: `${w}%` }}>{!compact && w > 12 ? pct(w) : ''}</span>}
      {d > 0 && <span className="wdl draw" style={{ width: `${d}%` }}>{!compact && d > 12 ? pct(d) : ''}</span>}
      {l > 0 && <span className="wdl loss" style={{ width: `${l}%` }}>{!compact && l > 12 ? pct(l) : ''}</span>}
    </div>
  )
}
