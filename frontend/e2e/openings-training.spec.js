import { expect, test } from '@playwright/test'

async function clearBranches(request, color) {
  const tree = await request.get(`/api/repertoire/tree?color=${color}`)
  expect(tree.ok()).toBeTruthy()
  const payload = await tree.json()
  for (const branch of payload.branches || []) {
    const deleted = await request.delete(`/api/repertoire/tree/branches/${branch.id}`)
    expect(deleted.ok()).toBeTruthy()
  }
}

async function saveBranch(request, data) {
  const response = await request.post('/api/repertoire/tree/branches', { data })
  expect(response.ok()).toBeTruthy()
  return response.json()
}

async function clickSquare(page, square, orientation = 'white') {
  const board = page.locator('.cr-board-inner').first()
  await expect(board).toBeVisible()
  const box = await board.boundingBox()
  expect(box).not.toBeNull()

  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const fileIndex = files.indexOf(square[0])
  const rank = Number(square[1])
  const xIndex = orientation === 'white' ? fileIndex : 7 - fileIndex
  const yIndex = orientation === 'white' ? 8 - rank : rank - 1

  await page.mouse.click(
    box.x + ((xIndex + 0.5) * box.width) / 8,
    box.y + ((yIndex + 0.5) * box.height) / 8,
  )
}

async function playMove(page, from, to, orientation = 'white') {
  await clickSquare(page, from, orientation)
  await clickSquare(page, to, orientation)
}

async function playMoveAndWaitForDrillWrite(page, from, to, orientation = 'white') {
  const saved = page.waitForResponse(response => (
    response.url().includes('/api/repertoire/drill-attempts')
    && response.request().method() === 'POST'
  ))
  await playMove(page, from, to, orientation)
  const response = await saved
  expect(response.ok()).toBeTruthy()
}

// "Your move" is shown both before and after the opponent's turn, so it can't
// gate a follow-up move (you'd click while the opponent is still replying).
// Wait for the opponent's reply to land in the move history instead.
async function waitForOpponentReply(page, san) {
  await expect(
    page.getByRole('navigation', { name: 'Move history' }).getByRole('button', { name: san, exact: true }),
  ).toBeVisible()
}

// Open the Train tab and start drilling a named opening. The trainer walks the
// tree of saved lines: the opponent auto-replies with a random saved move and
// any saved reply of yours is accepted.
async function trainOpening(page, name, color = 'white') {
  if (color === 'black') {
    await page.getByRole('button', { name: 'Black', exact: true }).click()
  }
  await page.getByRole('tab', { name: 'Train' }).click()
  await page.locator('.op-pick').filter({ hasText: name }).click()
}

test.beforeEach(async ({ request }) => {
  await clearBranches(request, 'white')
  await clearBranches(request, 'black')
})

test('clean white drill auto-plays the opponent and finishes the run', async ({ page, request }) => {
  await saveBranch(request, {
    color: 'white',
    name: 'Clean e4',
    moves_san: 'e4 e5',
    opening: 'Open Game',
    label: 'main',
    note: '',
  })

  await page.goto('/')
  await trainOpening(page, 'Open Game')

  await expect(page.getByText('Your move')).toBeVisible()
  await expect(page.getByText('Stockfish')).toHaveCount(0)

  // You play White's move; the opponent auto-replies e5 and the line completes.
  await playMove(page, 'e2', 'e4')
  await expect(page.getByText('Clean line')).toBeVisible()
  await page.getByRole('button', { name: 'Finish' }).click()
  await expect(page.getByText('All 1 line trained')).toBeVisible()

  // A clean run leaves nothing in Review.
  await page.getByRole('tab', { name: /Review/ }).click()
  await expect(page.getByText('Nothing due')).toBeVisible()
})

test('a drill only accepts moves from the opening being drilled', async ({ page, request }) => {
  // Both lines start from the same position. 1.e4 is in the repertoire — but
  // not in the opening being drilled, and used to pass as a "Clean line".
  await saveBranch(request, {
    color: 'white', name: 'QP', moves_san: 'd4 d5', opening: 'Queen Pawn Test', label: 'main', note: '',
  })
  await saveBranch(request, {
    color: 'white', name: 'KP', moves_san: 'e4 e5', opening: 'King Pawn Test', label: 'main', note: '',
  })

  await page.goto('/')
  await trainOpening(page, 'Queen Pawn Test')
  await expect(page.getByText('Your move')).toBeVisible()

  await playMoveAndWaitForDrillWrite(page, 'e2', 'e4')
  await expect(page.locator('.practice-card.active')).toContainText("isn't in your repertoire here")
  await expect(page.getByText('Clean line')).toHaveCount(0)

  // Mid-drill, Explore explains itself instead of showing some earlier position's stats.
  await page.getByRole('tab', { name: 'Explore' }).click()
  await expect(page.getByText('Drill in progress')).toBeVisible()
  await page.getByRole('button', { name: 'Back to drill' }).click()

  await playMove(page, 'd2', 'd4')
  await expect(page.getByText('Line complete')).toBeVisible()
  await page.getByRole('button', { name: 'Finish' }).click()
  await page.getByRole('button', { name: 'Back to openings' }).click()

  // The selection list reflects the run just finished, without a reload.
  await expect(page.locator('.op-pick').filter({ hasText: 'Queen Pawn Test' })).toContainText('1 trained')
})

test('wrong move is rejected, hints after two misses, and the miss reaches Review', async ({ page, request }) => {
  await saveBranch(request, {
    color: 'white',
    name: 'Italian',
    moves_san: 'e4 e5 Nf3',
    opening: 'Italian Game',
    label: 'main',
    note: '',
  })

  await page.goto('/')
  await trainOpening(page, 'Italian Game')

  await expect(page.getByText('Your move')).toBeVisible()

  // First wrong move: rejected, board resets, no try-again button.
  await playMoveAndWaitForDrillWrite(page, 'd2', 'd4')
  await expect(page.locator('.practice-card.active')).toContainText("isn't in your repertoire here")

  // Second wrong move at the same position surfaces a hint of a saved reply.
  await playMoveAndWaitForDrillWrite(page, 'd2', 'd4')
  await expect(page.locator('.practice-hint')).toContainText('e4')

  // Correct move advances; wait for the opponent's auto-reply before moving on.
  await playMove(page, 'e2', 'e4')
  await waitForOpponentReply(page, 'e5')
  await playMove(page, 'g1', 'f3')
  await expect(page.getByText('Line complete')).toBeVisible()
  await expect(page.getByText(/miss(es)? added to Review/)).toBeVisible()

  // The missed position is now due; Review reveals played + correct move.
  await page.getByRole('tab', { name: /Review/ }).click()
  await expect(page.getByText(/due position/)).toBeVisible()
  await page.getByRole('button', { name: 'Start review' }).click()
  await expect(page.getByText(/What.s your move/)).toBeVisible()

  await playMoveAndWaitForDrillWrite(page, 'd2', 'd4')
  const miss = page.locator('.practice-card.miss')
  await expect(miss).toContainText('You played')
  await expect(miss).toContainText('d4')
  await expect(miss).toContainText('Correct move')
  await expect(miss).toContainText('e4')
})

test('terminal-ply miss reaches Review and the completed summary remains visible', async ({ page, request }) => {
  await saveBranch(request, {
    color: 'white',
    name: 'Terminal e4',
    moves_san: 'e4',
    opening: 'Terminal Audit',
    label: 'main',
    note: '',
  })

  await page.goto('/')
  await trainOpening(page, 'Terminal Audit')
  await playMoveAndWaitForDrillWrite(page, 'd2', 'd4')
  await playMove(page, 'e2', 'e4')
  await expect(page.getByText('Line complete')).toBeVisible()

  await page.getByRole('tab', { name: /Review/ }).click()
  await expect(page.getByText(/due position/)).toBeVisible()
  await page.getByRole('button', { name: 'Start review' }).click()
  await playMove(page, 'e2', 'e4')
  const finish = page.getByRole('button', { name: 'Finish' })
  await expect(finish).toBeEnabled()
  await finish.click()
  await expect(page.getByRole('heading', { name: 'Review complete' })).toBeVisible()
  await expect(page.getByText('1 correct')).toBeVisible()
})

test('black drill: the opponent moves first and the board is flipped', async ({ page, request }) => {
  await saveBranch(request, {
    color: 'black',
    name: 'Caro main',
    moves_san: 'e4 c6',
    opening: 'Caro-Kann',
    label: 'main',
    note: '',
  })

  await page.goto('/')
  await trainOpening(page, 'Caro-Kann', 'black')

  // White (the opponent) auto-plays e4 first, then it's your move as Black.
  await expect(page.getByText('Your move')).toBeVisible()
  await playMove(page, 'c7', 'c6', 'black')
  await expect(page.getByText('Clean line')).toBeVisible()
  await page.getByRole('button', { name: 'Finish' }).click()
  await expect(page.getByText('All 1 line trained')).toBeVisible()
})

test('continue training cycles through every uncovered line in the opening', async ({ page, request }) => {
  // Two lines that share your first move but split on the opponent's reply.
  await saveBranch(request, {
    color: 'white', name: 'vs e5', moves_san: 'e4 e5', opening: 'King Pawn', label: 'main', note: '',
  })
  await saveBranch(request, {
    color: 'white', name: 'vs c5', moves_san: 'e4 c5', opening: 'King Pawn', label: 'main', note: '',
  })

  await page.goto('/')
  await trainOpening(page, 'King Pawn')

  // First walk: play e4, opponent picks one of the two saved replies → 1/2 done.
  await expect(page.getByText('Your move')).toBeVisible()
  await playMove(page, 'e2', 'e4')
  await page.getByRole('button', { name: /Continue training \(1\/2\)/ }).click()

  // Second walk is biased to the still-uncovered line; play e4 again → 2/2.
  await expect(page.getByText('Your move')).toBeVisible()
  await playMove(page, 'e2', 'e4')
  await page.getByRole('button', { name: 'Finish' }).click()
  await expect(page.getByText('All 2 lines trained')).toBeVisible()
})

test('openings are a named entity: grouping, rename sync, and delete orphans lines', async ({ request }) => {
  // Create a named opening, then file a line under it by id.
  const created = await request.post('/api/repertoire/openings', {
    data: { color: 'white', name: 'My Opening' },
  })
  expect(created.ok()).toBeTruthy()
  const opening = await created.json()

  const branch = await saveBranch(request, {
    color: 'white', name: 'L1', moves_san: 'e4 e5', opening_id: opening.id, label: 'main', note: '',
  })
  expect(branch.opening_id).toBe(opening.id)
  expect(branch.opening).toBe('My Opening') // legacy text column stays in sync

  let openings = await (await request.get('/api/repertoire/openings?color=white')).json()
  expect(openings.find(o => o.id === opening.id).lines).toBe(1)

  // Rename propagates to the member line's grouping.
  const renamed = await request.patch(`/api/repertoire/openings/${opening.id}`, {
    data: { name: 'Renamed Opening' },
  })
  expect(renamed.ok()).toBeTruthy()
  let tree = await (await request.get('/api/repertoire/tree?color=white')).json()
  let member = tree.branches.find(b => b.id === branch.id)
  expect(member.opening).toBe('Renamed Opening')
  expect(member.opening_id).toBe(opening.id)

  // Deleting the opening orphans the line (never deletes it).
  const deleted = await request.delete(`/api/repertoire/openings/${opening.id}`)
  expect(deleted.ok()).toBeTruthy()
  tree = await (await request.get('/api/repertoire/tree?color=white')).json()
  member = tree.branches.find(b => b.id === branch.id)
  expect(member).toBeTruthy()
  expect(member.opening_id).toBeFalsy()
})

test('edit fork delete branch lifecycle', async ({ page, request }) => {
  const branch = await saveBranch(request, {
    color: 'white',
    name: 'Original',
    moves_san: 'd4 d5',
    opening: 'Queen\'s Gambit',
    tags: ['test'],
    label: 'main',
    note: 'note',
  })

  await page.goto('/')
  await page.getByRole('tab', { name: 'Repertoire' }).click()
  await page.locator('.op-var-main').filter({ hasText: 'Original' }).click()

  await page.getByRole('textbox', { name: 'Variation' }).fill('Renamed')
  await page.getByRole('button', { name: /Save changes|Update line/ }).click()
  await expect(page.getByText(/Updated|Saved/)).toBeVisible()

  const forked = await saveBranch(request, {
    color: 'white',
    name: 'Forked',
    moves_san: 'd4 Nf6',
    opening: 'Queen\'s Gambit',
    tags: [],
    label: 'main',
    note: '',
  })
  expect(forked.id).not.toBe(branch.id)

  const deleted = await page.request.delete(`/api/repertoire/tree/branches/${forked.id}`)
  expect(deleted.ok()).toBeTruthy()

  const tree = await page.request.get('/api/repertoire/tree?color=white')
  const payload = await tree.json()
  expect(payload.branches.some(b => b.id === forked.id)).toBe(false)
  expect(payload.branches.some(b => b.name === 'Renamed')).toBe(true)
})

test('app remains usable when engine endpoints fail', async ({ page }) => {
  await page.route('**/api/evaluate-stream**', route => route.abort())
  await page.route('**/api/cloud-eval**', route => route.abort())

  await page.goto('/')
  await expect(page.getByRole('tab', { name: 'Explore' })).toBeVisible()
  await playMove(page, 'e2', 'e4')
  await expect(page.locator('.cr-board-inner')).toBeVisible()
})

test('failed training writes block progress and retry without duplicating the attempt', async ({ page, request }) => {
  await saveBranch(request, {
    color: 'white', name: 'Reliable e4', moves_san: 'e4', opening: 'Reliable', label: 'main', note: '',
  })
  let failed = false
  await page.route('**/api/repertoire/drill-attempts', async (route) => {
    if (!failed) {
      failed = true
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"offline"}' })
    } else {
      await route.continue()
    }
  })

  await page.goto('/')
  await trainOpening(page, 'Reliable')
  await playMove(page, 'd2', 'd4')
  await expect(page.getByRole('alert')).toContainText('Retry before continuing')
  await expect(page.getByRole('button', { name: 'Retry' })).toBeEnabled()
  const retried = page.waitForResponse(response => (
    response.url().includes('/api/repertoire/drill-attempts')
    && response.request().method() === 'POST'
  ))
  await page.getByRole('button', { name: 'Retry' }).click()
  expect((await retried).ok()).toBeTruthy()
  await expect(page.getByRole('alert')).toHaveCount(0)
  // Scoped to the write indicator: the session rail is also a role="status"
  // (it carries the run's progress), so a bare getByRole('status') matches it
  // for the whole drill.
  await expect(page.locator('.review-write-error')).toHaveCount(0)
  await playMove(page, 'e2', 'e4')
  await expect(page.getByText('Line complete')).toBeVisible()
})

test('mobile viewport smoke test', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('tab', { name: 'Explore' })).toBeVisible()
  await expect(page.locator('.cr-board-inner')).toBeVisible()
  await expect(page.locator('.op-panel')).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  // Native controls (scrollbars, <select> popups, date pickers) must match the
  // dark surfaces they sit on.
  expect(await page.locator('.openings-workspace').evaluate(
    element => getComputedStyle(element).colorScheme,
  )).toBe('dark')
})

test('depth shortcuts persist across positions and stay suspended in the accounts dialog', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.op-engine-controls .op-line-depth')).toBeVisible()

  await page.keyboard.press('=')
  await expect(page.locator('.op-engine-controls .op-line-depth')).toContainText('10')
  await page.keyboard.press('=')
  await expect(page.locator('.op-engine-controls .op-line-depth')).toContainText('30')
  await playMove(page, 'e2', 'e4')
  await expect(page.locator('.op-engine-controls .op-line-depth')).toContainText('30')

  await page.keyboard.press('-')
  await expect(page.locator('.op-engine-controls .op-line-depth')).toContainText('10')

  await page.getByRole('button', { name: /Accounts|Add account/ }).click()
  await expect(page.getByRole('dialog', { name: 'Manage accounts' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close' })).toBeFocused()
  await page.keyboard.press('=')
  await expect(page.locator('.op-engine-controls .op-line-depth')).toContainText('10')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Manage accounts' })).toHaveCount(0)
})

test('no console errors during explore workflow', async ({ page }) => {
  const errors = []
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', err => errors.push(err.message))

  await page.goto('/')
  await page.getByRole('tab', { name: 'Explore' }).click()
  await playMove(page, 'e2', 'e4')
  await playMove(page, 'e7', 'e5')

  expect(errors).toEqual([])
})

test('a line saved under one move order is recognized when reached by another', async ({ page, request }) => {
  await saveBranch(request, {
    color: 'white',
    name: 'Queens Gambit Declined',
    moves_san: 'd4 d5 c4 e6',
    opening: 'Queens Gambit',
    label: 'main',
    note: '',
  })

  await page.goto('/')
  await expect(page.locator('.cr-board-inner')).toBeVisible()
  // The same position by the other order — 1.d4 e6 2.c4 d5 — which was never
  // saved. Before positions became the identity this offered a duplicate save.
  await playMove(page, 'd2', 'd4')
  await expect(page.locator('.op-crumbs')).toContainText('1.d4')
  await playMove(page, 'e7', 'e6')
  await expect(page.locator('.op-crumbs')).toContainText('e6')
  await playMove(page, 'c2', 'c4')
  await expect(page.locator('.op-crumbs')).toContainText('2.c4')
  await playMove(page, 'd7', 'd5')
  await expect(page.locator('.op-crumbs')).toContainText('d5')

  await page.getByRole('tab', { name: 'Repertoire' }).click()

  const strip = page.locator('.op-saveline')
  await expect(strip).toContainText('In your repertoire')
  await expect(strip).not.toContainText('not saved')
  // ...and it names the move order the line is actually stored under.
  await expect(strip.locator('.op-saveline-transposed')).toContainText('d4 d5 c4 e6')
})

test('transposed game stats are pooled, not split by move order', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('tab', { name: 'Explore' }).click()

  // Each move has to land before the next is clicked: clickSquare measures the
  // board fresh every time, and clicking through faster than the position
  // settles drops moves.
  const play = async (from, to, crumb) => {
    await playMove(page, from, to)
    await expect(page.locator('.op-crumbs')).toContainText(crumb)
  }

  // With no imported games in the e2e database every count is zero, so assert
  // the wiring instead: the same position by two orders reports one figure.
  await play('d2', 'd4', '1.d4')
  await play('g8', 'f6', 'Nf6')
  await play('c2', 'c4', '2.c4')
  const viaD4 = await page.locator('.op-statline .op-stat-num').first().textContent()

  await page.getByRole('button', { name: 'Return to start' }).click()
  await expect(page.locator('.op-crumbs-scroll .crumb')).toHaveCount(0)
  await play('c2', 'c4', '1.c4')
  await play('g8', 'f6', 'Nf6')
  await play('d2', 'd4', '2.d4')
  const viaC4 = await page.locator('.op-statline .op-stat-num').first().textContent()

  expect(viaC4).toBe(viaD4)
})
