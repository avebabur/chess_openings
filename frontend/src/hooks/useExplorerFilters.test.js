import { describe, expect, it } from 'vitest'
import { EMPTY_FILTERS, withMonth } from './useExplorerFilters'

describe('withMonth', () => {
  it('never produces a range that starts after it ends', () => {
    const range = { ...EMPTY_FILTERS, since: '2023-01', until: '2023-06' }
    // Moving From past To drags To along, and vice versa — the backend (and
    // Lichess) reject since > until, which used to blank the explorer.
    expect(withMonth(range, 'since', '2024-05')).toMatchObject({ since: '2024-05', until: '2024-05' })
    expect(withMonth(range, 'until', '2022-03')).toMatchObject({ since: '2022-03', until: '2022-03' })
  })

  it('leaves a valid or open-ended range alone', () => {
    expect(withMonth({ ...EMPTY_FILTERS, until: '2023-06' }, 'since', '2023-02'))
      .toMatchObject({ since: '2023-02', until: '2023-06' })
    expect(withMonth({ ...EMPTY_FILTERS, since: '2023-06' }, 'until', ''))
      .toMatchObject({ since: '2023-06', until: '' })
  })
})
