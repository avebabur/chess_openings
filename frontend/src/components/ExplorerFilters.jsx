import { RATING_BANDS, SPEEDS } from '../hooks/useExplorerFilters'

/* Narrowing controls for the Lichess players explorer, laid out for the 300px rail.
 *
 * Nothing selected in a group means "all" — the same convention lichess.org uses, and
 * the reason the backend omits an empty filter from the upstream query entirely rather
 * than enumerating every value.
 */
export default function ExplorerFilters({
  filters,
  isDefault,
  onToggleSpeed,
  onToggleRating,
  onSetSince,
  onSetUntil,
  onReset,
}) {
  return (
    <div className="op-explorer-filters">
      <div className="op-explorer-filter-group" role="group" aria-label="Time control">
        <span className="op-explorer-filter-label">Time control</span>
        <div className="op-explorer-chips">
          {SPEEDS.map(speed => (
            <button
              key={speed.key}
              type="button"
              className={`chip ${filters.speeds.includes(speed.key) ? 'on' : ''}`}
              onClick={() => onToggleSpeed(speed.key)}
              aria-pressed={filters.speeds.includes(speed.key)}
            >
              {speed.label}
            </button>
          ))}
        </div>
      </div>

      <div className="op-explorer-filter-group" role="group" aria-label="Rating">
        <span className="op-explorer-filter-label">Rating</span>
        <div className="op-explorer-chips">
          {RATING_BANDS.map(band => (
            <button
              key={band.key}
              type="button"
              className={`chip ${filters.ratings.includes(band.key) ? 'on' : ''}`}
              onClick={() => onToggleRating(band.key)}
              aria-pressed={filters.ratings.includes(band.key)}
            >
              {band.label}
            </button>
          ))}
        </div>
      </div>

      <div className="op-explorer-filter-group">
        <span className="op-explorer-filter-label">Date range</span>
        {/* Stacked, not side by side: a native month input carries a wide intrinsic
          * minimum (the picker chrome), so two of them overflow the 300px rail. */}
        <div className="op-explorer-months">
          <label>
            <span>From</span>
            <input
              type="month"
              min="1952-01"
              value={filters.since}
              onChange={(e) => onSetSince(e.target.value)}
            />
          </label>
          <label>
            <span>To</span>
            <input
              type="month"
              min="1952-01"
              value={filters.until}
              onChange={(e) => onSetUntil(e.target.value)}
            />
          </label>
        </div>
      </div>

      <button
        type="button"
        className="op-explorer-filter-reset"
        onClick={onReset}
        disabled={isDefault}
      >
        Reset filters
      </button>
    </div>
  )
}
