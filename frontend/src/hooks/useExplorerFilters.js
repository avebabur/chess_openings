import { useCallback, useMemo, useState } from 'react'

/* Filters for the Lichess players explorer — the same three knobs lichess.org offers.
 *
 * The values are Lichess's own enums, not ours: `SPEEDS` are its speed names and
 * `RATING_BANDS` are band LOWER BOUNDS (selecting 1600 means "1600-1800"), which is why
 * there is no free-form rating entry. The backend re-validates all of this, so a stale
 * localStorage entry from an older build can't smuggle a bad value upstream.
 */

const STORAGE_KEY = 'openings.explorerFilters.v1'

export const SPEEDS = [
  { key: 'ultraBullet', label: 'UltraBullet' },
  { key: 'bullet', label: 'Bullet' },
  { key: 'blitz', label: 'Blitz' },
  { key: 'rapid', label: 'Rapid' },
  { key: 'classical', label: 'Classical' },
  { key: 'correspondence', label: 'Corr.' },
]

const BAND_BOUNDS = [400, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500]

export const RATING_BANDS = BAND_BOUNDS.map((low, i) => ({
  key: low,
  label: i === BAND_BOUNDS.length - 1 ? `${low}+` : `${low}–${BAND_BOUNDS[i + 1]}`,
}))

const MONTH_RE = /^(19|20)\d{2}-(0[1-9]|1[012])$/
const MIN_YEAR = 1952

export const EMPTY_FILTERS = { speeds: [], ratings: [], since: '', until: '' }

/** Keep only values Lichess accepts — guards against a stale/hand-edited storage entry. */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return EMPTY_FILTERS
  const speedKeys = SPEEDS.map(s => s.key)
  const month = (value) => (
    typeof value === 'string' && MONTH_RE.test(value) && Number(value.slice(0, 4)) >= MIN_YEAR
      ? value
      : ''
  )
  const since = month(raw.since)
  const until = month(raw.until)
  const inverted = since && until && since > until
  return {
    speeds: (Array.isArray(raw.speeds) ? raw.speeds : []).filter(s => speedKeys.includes(s)),
    ratings: (Array.isArray(raw.ratings) ? raw.ratings : []).filter(r => BAND_BOUNDS.includes(r)),
    // Lichess (and our backend) reject since > until; a stored inverted range
    // would leave the explorer "unavailable" on every load until reset.
    since: inverted ? '' : since,
    until: inverted ? '' : until,
  }
}

/** Set one end of the month range, dragging the other end along rather than
 *  ever producing since > until (YYYY-MM strings compare chronologically). */
export function withMonth(filters, key, value) {
  const next = { ...filters, [key]: value }
  if (next.since && next.until && next.since > next.until) {
    if (key === 'since') next.until = value
    else next.since = value
  }
  return next
}

function load() {
  try {
    return sanitize(JSON.parse(window.localStorage.getItem(STORAGE_KEY)))
  } catch {
    return EMPTY_FILTERS
  }
}

function save(filters) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(filters))
  } catch {
    // Private browsing / quota — the filters still work, they just don't persist.
  }
}

function toggle(list, value) {
  return list.includes(value) ? list.filter(v => v !== value) : [...list, value]
}

export function useExplorerFilters() {
  const [filters, setFilters] = useState(load)

  const setMonth = useCallback((key, value) => {
    setFilters((previous) => {
      const next = withMonth(previous, key, value)
      save(next)
      return next
    })
  }, [])

  const toggleSpeed = useCallback((speed) => {
    setFilters((previous) => {
      const next = { ...previous, speeds: toggle(previous.speeds, speed) }
      save(next)
      return next
    })
  }, [])

  const toggleRating = useCallback((band) => {
    setFilters((previous) => {
      const next = { ...previous, ratings: toggle(previous.ratings, band) }
      save(next)
      return next
    })
  }, [])

  const reset = useCallback(() => {
    save(EMPTY_FILTERS)
    setFilters(EMPTY_FILTERS)
  }, [])

  // A stable, order-independent string: the effect dependency and the "is anything
  // set?" test in one. Sorting means re-picking the same chips in a different order
  // doesn't refetch.
  const filterKey = useMemo(() => [
    [...filters.speeds].sort().join(','),
    [...filters.ratings].sort((a, b) => a - b).join(','),
    filters.since,
    filters.until,
  ].join('|'), [filters])

  return {
    filters,
    filterKey,
    isDefault: filterKey === '|||',
    toggleSpeed,
    toggleRating,
    setSince: (since) => setMonth('since', since),
    setUntil: (until) => setMonth('until', until),
    reset,
  }
}
