import { branchCleanRate } from '../../utils/formatUtils'

/** Compact drill-result pill: clean % (green when 100), or a dashed "new". */
export default function ScorePill({ branch }) {
  const clean = branchCleanRate(branch)
  if (clean == null) {
    return <span className="score-pill new" title="Not drilled yet">new</span>
  }
  return (
    <span
      className={`score-pill${clean >= 100 ? ' clean' : ''}`}
      title={`${branch.drill_solved}/${branch.drill_count} clean`}
    >
      {clean}%
    </span>
  )
}
