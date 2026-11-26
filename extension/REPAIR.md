# Repairing the extension after a Lichess change

Instructions for an agent. Goal: every feature in the table below shows on its page
again, without breaking Lichess's page and without showing anything on a game page.

## 1. See what is broken

```bash
cat extension/health-report.json          # what the installed extension saw
node extension/scripts/check.mjs          # fresh check against real lichess.org (app must run on :8001)
```

`health-report.json` → `broken[]` gives, for each missing feature: `page_kind`
(`analyse` = analysis board / finished game, `round` = game in progress, `other`),
`feature`, `status`, and `missing_anchors[]` with the **anchor name and the selector that
stopped matching**. `check.mjs` writes screenshots to `extension/check-output/`.

Statuses: `ok` showing · `missing` its anchor is gone · `hidden` it was added but has no
size (Lichess's CSS now hides it, or its container moved) · `error` it threw (see the
browser console, prefix `[openings]`) · `n/a` not for this page (or a game in progress).
Only `missing`, `hidden` and `error` need fixing.

## 2. What should be visible, and where

| feature | page | anchor(s) in `src/anchors.js` | placed |
|---|---|---|---|
| engine (Your Stockfish in Lichess) | analyse | `ceval` | after Lichess's engine bar; usually empty (`ok` with no size is normal) |
| repertoire (Your repertoire) | analyse | `side` + position | left column, last |
| explorerleft (explorer in the left column) | analyse | `side` (+ `explorerBox`, the board) | an empty space at the end of the left column; Lichess's explorer is positioned over it on wide layouts |
| annotate (Annotate chapter) | analyse | `moveList` | after the move list, only in a study chapter you can change; empty elsewhere (`ok` with no size is normal) |
| mine (My games tab) | analyse | `explorerTitle` (optional: `n/a` while the explorer is closed) | in the explorer's tab row, before the gear; its content goes in the explorer's `.data` |

"analyse" covers the analysis board, finished games and studies. The **position** comes
from `fenInput` (analysis board, finished games). Studies have no FEN box: there it is
asked of Lichess's controller (`ctrl.node.fen`, and `ctrl.tree.root.fen` for where the
chapter starts, through `src/page-bridge.js`), because a chapter that starts from a set-up
position does not list its FEN anywhere on the page. Only if the controller can't be
reached is it replayed from `moveList` + `activeMove` (+ a `studyTags` FEN) with
`vendor/chess.js`. Interactive study lessons (`OX.gamebookClass` on `main`) deliberately
show nothing. Page detection uses `analysePage` and `roundPage`.
`OX.notGames` in `src/anchors.js` lists
the Lichess pages whose address has the shape of a game id but are not games (`/training`,
`/practice`…, from lila's `conf/routes`), so they are not taken for a game's page when the
health report decides whether the analysis features were expected there.

Not reported as broken, because Lichess itself leaves the engine bar out there: `engine`
in studies (the author can switch computer analysis off), with `?evals=0`, and in Lichess's
one-column layout of a narrow window (`OX.oneColumn`, the `---display-columns` variable on
`<body>`). See `expected` in `src/features/engine.js`.

Things that rely on Lichess internals rather than selectors, and fail quietly:
- **Lichess's controller** (`src/lichess.js`): `window.site.analysis` with `playUci`,
  `playUciList`, `jumpToMain`, `togglePractice` (lila `ui/analyse/src/ctrl.ts`). If clicking
  a move or Jump stops moving the board, check those names.
- **Lichess's engine bar stays on an error after the app was down** (`src/page-bridge.js`,
  `restartCeval`): when the app answers again the extension calls Lichess's
  `ctrl.startCevalIfEnabled()` (lila `ui/analyse/src/ctrl.ts`). It first drops any empty
  answer from `ctrl.node.ceval`, and in Practice calls `ctrl.practice.onJump()` so the
  computer takes its turn again (lila `ui/analyse/src/practice/practiceCtrl.ts`, its
  `played` flag). If the bar no longer restarts by itself, or Practice stays on
  "Computer thinking…" after the app came back, check those names. Lichess runs its engine in one
  tab at a time (lila `ui/lib/src/ceval/ctrl.ts`, `ceval.fen` / `wasUnloadedByAnotherWindow`):
  a tab that starts a search switches the engine off in the others. So only the tab you
  are in searches again; another tab does only when its position has no answer at all,
  and a hidden one waits until it is shown. If after a game the engine is switched off in
  the tab in front, look there.
- **Practice stuck on "Computer thinking…"** (`src/page-bridge.js`, `nudgePractice`): in
  Practice's Mastery mode Lichess only moves once the engine is idle, and with an external
  engine nothing re-checks after it stops. The bridge calls `ctrl.practice.onCeval()` when
  Practice is waiting, the result has a `bestmove` and `ctrl.ceval.isComputing` is false
  (names from lila `ui/analyse/src/practice/practiceCtrl.ts`). If it hangs again, check those.
- **Analysis answered on this computer** (`src/page-bridge.js` `localAnalyse`,
  `src/engine-relay.js`, `analyseHere` in `src/background.js`, `POST
  /api/lichess-engine/analyse` and `local_analysis`/`BrokerEmit` in
  `backend/lichess_engine_provider.py`): the page's `…/api/external-engine/<id>/analyse`
  request never leaves the computer. The bridge hands it to the relay with an `ox-engine`
  event (the relay acks synchronously in `<html data-ox-engine-ack>`), the relay opens a
  port `ox-engine` to the background script, which POSTs `{engineId, work}` to the app and
  passes the ndjson back (`start`, `chunk`…, `end`); the bridge gives Lichess a `Response`
  streaming it. The app answers exactly what Lichess's broker would have (lila-engine
  `src/emit.rs`, read by lila `ui/lib/src/ceval/engines/externalEngine.ts`). If Lichess
  changes that format (the engine bar shows nothing although `GET /api/lichess-engine`
  lists `via: local` jobs with lines), compare those two files with `BrokerEmit`. Cancelling
  closes the port, which aborts the app's request and stops Stockfish (`ended:
  cancelled`). During a game the background script answers the empty search itself and the
  app answers it too (both fail-closed). No ack, `unavailable` (app down, or 404: the engine
  is not the app's) or a port that drops before `start` sends the request to the broker
  with the pacing below, unchanged. Stepping at 0.4 s a move (Nov 2026): lines at every
  move, first line in ~25 ms, `GET /api/lichess-engine` shows only `via: local` jobs.
  Faster than every 0.25 s Lichess itself sends nothing until you stop (its client
  debounces). The broker registration stays: Lichess offers the engine only because of it.
- **"Your Stockfish error: TypeError: Failed to fetch"** (`src/page-bridge.js`, `pacedAnalyse`;
  now only when the request goes to the broker, see above):
  Lichess's engine service (`engine.lichess.ovh`, behind nginx) allows each address a limited
  number of requests: measured in November 2026, about 60 at once and then two or three a
  second. Every position costs three (the page's `…/analyse` request, and the app taking the
  job and answering it), so stepping through a game at two positions a second ran out in a
  quarter of a minute. Past the limit nginx answers a bare 503 without CORS headers, which
  the page sees as a network failure; Lichess then shows that pop-up and switches the engine
  off. The bridge wraps `window.fetch` for that one request only and keeps count
  (`BUDGET_MAX`, `BUDGET_PER_SECOND`, shared by all tabs in `localStorage` under
  `ox.engineBudget`): the first dozen positions go out at once, later ones every second and a
  half, a request Lichess cancels while waiting is never sent, and a refusal is tried again
  three times before Lichess hears of it. Before move 15 (and in studies) a request first
  waits up to 0.3 s for Lichess's cloud evaluation, and is not sent when Lichess's own rule
  says the cloud wins (`letCloudWin` in lila `ui/lib/src/ceval/ctrl.ts`; `canEvalGet` in
  `ui/analyse/src/ctrl.ts` says where Lichess looks). If opening positions start costing
  requests again ("Loading engine" soon after an opening), check those two names. If the
  pop-up comes back, Lichess has lowered its limit: lower those two numbers. `GET /api/lichess-engine` shows the app's side: a `broker`
  of 503 in `recent`, or the error "Lichess's engine service answered 503", is the same limit.
  To see it: `node extension/scripts/engine-pacing-test.mjs`, and in Chrome step through a
  long game with `site.analysis.jumpToMain(n)` every 400 ms.
- **Left column height** (`src/features/explorerleft.js`): limits the repertoire box's height
  (`--ox-max`) and sets the height of Lichess's chat (`main.analyse > .mchat`) so the column
  ends at the board's bottom. A gap under the board or a squeezed chat means this stopped.
- **Page styles** (`src/page.css`, applied by Chrome from the manifest): the board colours,
  hiding the WikiBook and the explorer's Player tab, and swapping the explorer's tables while
  My games is chosen.
- **Engine choice:** `src/engine-select.js` and `features/engine.js` write the engine id
  into Lichess's localStorage key `ceval.engine.<variant>` (see `storedEngine` in lila's
  `ui/lib/src/ceval/ctrl.ts`). If Lichess's engine bar stops using "Your Stockfish" although `GET /api/lichess-engine` says `ready`, check that key name.
- **The engine link itself** (`backend/lichess_engine_provider.py`) follows
  lichess-org/external-engine's `example-provider.py`. `GET /api/lichess-engine` shows its
  state and last error; `venv/bin/python extension/scripts/engine_check.py` (add
  `--practice`) tests it end to end through Lichess's broker.

## 3. Find the new selector

Look at the live page. Cloudflare blocks headless browsers on game pages, so use
`/analysis/pgn/e4_e5_Nf3` (the analysis board) and a public study such as
`/study/Of3mcPk8` for the `analyse` anchors. A minimal probe:

```js
// node, with Playwright from extension/scripts/node_modules, headless Chrome (channel: 'chrome')
await page.goto('https://lichess.org/analysis/pgn/e4_e5_Nf3', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
// print main's structure to 3 levels, and look for the FEN input:
[...document.querySelectorAll('input')].filter(i => i.value.includes('/')).map(i => i.className)
```

Lichess's source is public: https://github.com/lichess-org/lila (`ui/analyse/src/view/`
for the analysis page, `ui/round` for game pages, `ui/site` for the top menu). Search
its recent commits for the old class name to see what replaced it.

## 4. Fix

- Change **only the selector in `src/anchors.js`** when that is enough (almost always).
- If the structure changed (for example the FEN box is gone entirely), change how
  `OX.readPosition()` in `src/core.js` finds the position, or a feature's `place`.
- Rules that must stay true:
  - Features only add elements. The few deliberate changes to Lichess's own layout stay in
    `src/page.css` and `src/features/explorerleft.js`; don't add more elsewhere.
  - Never stop Lichess's events, except keys typed inside our own text boxes.
  - Never touch Lichess's requests, except one: the page's request to Lichess's engine
    service (`src/page-bridge.js`), answered by the app on this computer or else paced.
    Everything else passes through `window.fetch` unchanged, and so does that one whenever
    anything about it is unexpected.
  - Never make features run on `roundPage` (a game page) or on a forecast board
    (`OX.isGameForecastPath`).
- Bump `version` in `manifest.json`.

## 5. Verify

```bash
node extension/scripts/check.mjs                                  # must end "Everything showed…"
OX_CHECK_MOVES=d4_d5_c4 node extension/scripts/check.mjs          # any line, e.g. one from the repertoire
OX_CHECK_STUDY=https://lichess.org/study/XXXXXXXX node extension/scripts/check.mjs   # if the default study is gone
```

Look at `extension/check-output/analysis.png`, `study.png` and `home.png`: the boxes should look like
part of Lichess. The installed extension picks the change up by itself the next time a Lichess
page loads (the app tells it its files changed, and open tabs get the new copy without a reload).
