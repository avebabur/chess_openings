# Repairing the extension after a Lichess change

Instructions for an agent. Goal: every feature in the table below shows on its page
again, without breaking Lichess's page and without weakening the live-game lock.

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
browser console, prefix `[openings]`) · `paused` live-game lock · `n/a` not for this page.
Only `missing`, `hidden` and `error` need fixing.

## 2. What should be visible, and where

| feature | page | anchor(s) in `src/anchors.js` | placed |
|---|---|---|---|
| engine (Your Stockfish in Lichess) | analyse | `ceval` | after Lichess's engine bar; usually empty (`ok` with no size is normal) |
| sidetabs (Left column tabs) | analyse | `side` | left column, a tab row (My game / Repertoire) above the two boxes below, shown only when one of your games is open; only the open tab's box is shown, so the other having no size is normal |
| game (Your game) | analyse | `side` | left column; empty unless one of your games is open |
| repertoire (Your repertoire) | analyse | `side` + position | left column, last |
| explorerleft (explorer in the left column) | analyse | `side` (+ `explorerBox`, the board) | an empty space at the end of the left column; Lichess's explorer is positioned over it on wide layouts |
| mine (My games tab) | analyse | `explorerTitle` (optional: `n/a` while the explorer is closed) | in the explorer's tab row, before the gear; its content goes in the explorer's `.data` |

"analyse" covers the analysis board, finished games and studies. The **position** comes
from `fenInput` (analysis board, finished games) or, in studies, from `moveList` +
`activeMove` (+ the optional `studyTags` FEN), replayed with `vendor/chess.js`.
Interactive study lessons (`OX.gamebookClass` on `main`) deliberately show nothing.
Page detection uses `analysePage`, `roundPage` and `roundFinished`.

Things that rely on Lichess internals rather than selectors, and fail quietly:
- **Lichess's controller** (`src/lichess.js`): `window.site.analysis` with `playUci`,
  `playUciList`, `jumpToMain`, `togglePractice` (lila `ui/analyse/src/ctrl.ts`). If clicking
  a move or Jump stops moving the board, check those names.
- **Practice stuck on "Computer thinking…"** (`src/page-bridge.js`, `nudgePractice`): in
  Practice's Mastery mode Lichess only moves once the engine is idle, and with an external
  engine nothing re-checks after it stops. The bridge calls `ctrl.practice.onCeval()` when
  Practice is waiting, the result has a `bestmove` and `ctrl.ceval.isComputing` is false
  (names from lila `ui/analyse/src/practice/practiceCtrl.ts`). If it hangs again, check those.
- **Left column height** (`src/features/explorerleft.js`): limits the open tab's height
  (`--ox-max`) and sets the height of Lichess's chat (`main.analyse > .mchat`) so the column
  ends at the board's bottom. A gap under the board or a squeezed chat means this stopped.
- **Page styles** (`src/page.css`, applied by Chrome from the manifest): the board colours,
  hiding the WikiBook and the explorer's Player tab, and swapping the explorer's tables while
  My games is chosen.
- **Engine choice:** `src/engine-select.js` and `features/engine.js` write the engine id
  into Lichess's localStorage key `ceval.engine.<variant>` (see `storedEngine` in lila's
  `ui/lib/src/ceval/ctrl.ts`). If Lichess's engine bar stops using "Your Stockfish
  (openings app)" although `GET /api/lichess-engine` says `ready`, check that key name.
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
  - The live-game lock stays fail-closed: if `roundFinished` can't be found, games
    count as live. Never make features run on `roundPage`.
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
