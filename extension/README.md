# Openings for Lichess (Chrome extension)

Adds your openings tools to lichess.org itself. You keep playing on the real Lichess,
and the app's features sit inside Lichess's own pages, in Lichess's colours (light, dark
and transparent themes all match).

The extension gets data from the local service. You don't need to start it: opening
Lichess starts it (after the one-time `sh extension/native/install.sh`).

## What it adds

| Where on Lichess | Feature | What it does |
|---|---|---|
| Lichess's own engine bar, eval bar and "Practice with computer" | **Your Stockfish in Lichess** | Your Mac's Stockfish 19 serves Lichess through its external engine API and uses three search threads. Lichess's engine settings (search time 8 s by default, lines, memory) apply. Practice answers as Lichess asks: normal Practice in about a second, Mastery mode in your search time (8 s by default; lower it in Lichess's engine settings for faster replies). `OPENINGS_PRACTICE_SECONDS` forces a fixed time. A small box under the engine bar appears only when something needs you. |
| Under the move list, in every study chapter | **Deep analysis** and **Annotate chapter** | Open a chapter and it is analysed by itself on your Stockfish: every position for 90 seconds, with no depth limit (an endgame or a forced line goes as deep as Stockfish can, up to its maximum, depth 245, where it stops by itself; a middlegame reaches about depth 28-36). It runs on the same Stockfish as Lichess's engine bar, at the same priority. Opening positions take Lichess's cloud evaluation where it has depth 38 or more. Stockfish works from the last move backwards and keeps its memory between positions, and every result is saved in the app, so a chapter opened again (or a position met again) costs nothing. The bar shows how far it is ("Deep analysis: 23 of 64 positions", the move being searched and its depth, at most how long is left) with **Pause** / **Resume**. Each finished result goes on its move: Lichess's engine bar and arrows show it there and don't search that move again. Lichess's engine bar comes first: the analysis waits while it searches, and stops when you close the chapter. In a chapter you can change, once every move has its result the analysis is published to the chapter by itself (the same request as Lichess's "Analyse on your device" → Publish) and Lichess marks the moves: ?!, ?, ??, "X was best" with its line, the accuracy chart. It is published again only when the chapter or a result changes; **Annotate chapter** publishes at once with what there is. |
| Left column (the WikiBook is hidden) | **Repertoire** | Saved lines for the board position appear automatically, with the current move order first. Use **Edit** to change a line's name, type, or moves. Play the new move order on the board, choose **Use board moves**, and save the changes. **Manage saved lines** searches the whole repertoire by moves or name. Each saved line can also be deleted or extended. |
| Left column, under the repertoire | **Opening explorer** | Lichess's explorer moved from the right column (which keeps the engine and moves). Its **My games** tab replaces Lichess's Player tab (on variant boards, where My games has nothing, Lichess's Player tab stays): your chess.com and Lichess games as one history, newest first; it shows the side at the bottom of the board, and **As white ⇄** switches. Results are green for a win and red for a loss. **Sync games** brings in your newest games from every account. Opening a game: a Lichess game opens on its own Lichess page, a chess.com game on the analysis board, turned to your side, with its players and result filled in if you save it to a study with Lichess's Study button. |

These run on the analysis board, your games and studies (interactive lessons excluded). No
links lead out of Lichess.

## Setup on this Mac (once)

1. **Auto-start:** run `sh extension/native/install.sh` yourself, once. It registers a
   launchd job (`com.openings.app`, which runs `./start.sh`, not at login) and Chrome's
   helper. The app must not live in `~/Documents`: macOS doesn't let background services
   open that folder (that's why it moved to `~/code/openings`). Opening Lichess then asks launchd to start the app if it isn't running. Closing the
   last Lichess tab (and the settings page) stops it at once, Stockfish included. While
   they are open the extension tells the app every half minute, and the app stops itself
   after two minutes without hearing from it, so it also stops when Chrome is quit,
   crashes, or the extension is turned off (log:
   `~/Library/Logs/openings-app.log`, kept under 2 MB). An app you started yourself with
   `./start.sh` in Terminal is never stopped. Undo: `sh extension/native/install.sh --uninstall`.
2. **Your Stockfish in Lichess:** the app needs a Lichess token with engine access. Click the extension icon and open its settings page. The link there pre-ticks
   *engine:read* and *engine:write*. The app then registers "Your Stockfish"
   on your Lichess account, and the extension picks it in Lichess's engine menu for you.
   To undo: Lichess → analysis → engine settings → delete the engine, and remove the token.

## Nothing shows while you play

- The features only run on analysis pages: the analysis board, finished games and studies.
  A game page (one you play or watch, Lichess TV included) never shows anything of the
  extension, and neither does the analysis board of a game still in progress (its forecast
  board). Other tabs are left as they are.
- If the app stops unexpectedly while Lichess is open, the extension starts it again within
  half a minute, and the boxes and Lichess's engine bar recover by themselves.

## Install in Chrome (once)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose the folder `~/code/openings/extension`.
   Its id is always `jedkgjcnhhhbioonbcfiabgmeicodnfn` (fixed by the `key` in the manifest),
   which is what lets the start helper trust it.
3. Run `sh ~/code/openings/extension/native/install.sh` (auto start/stop).
4. Pin it: puzzle-piece icon → pin "Openings for Lichess".

After a code change nothing is needed: the next Lichess page you open makes the extension
reload itself, and tabs already open get the new copy. (Changes to `manifest.json` permissions
still need the reload button on `chrome://extensions`.)

## When Lichess changes its pages

Lichess updates its site about 35 times a day. If one of those changes moves something
the extension relies on:

- That feature is simply **left out**. The rest keep working and Lichess's page is never
  broken.
- The toolbar icon shows **!**, and its tooltip names the missing features.
- `extension/health-report.json` lists exactly which feature is missing, on which kind of
  page, and which selector stopped matching.

To check on demand, without installing anything, run this (the app must be running):

```bash
node extension/scripts/check.mjs
```

Install the browser-check dependency with `npm install --prefix extension/scripts`. The extension and local service do not need Node.

It opens real Lichess pages, runs the extension in them, checks that game pages stay clean, and
prints what's showing. To fix, hand an agent `extension/REPAIR.md`.

## Files

- `src/anchors.js`: every Lichess selector the extension uses. Repairs happen here.
- `src/core.js`: page detection, placing features, health reports.
- `src/page.css`: the few styles applied to Lichess's own page (hidden WikiBook, explorer in the left column).
- `src/styles.js`: the styles of the added boxes (inside their shadow roots).
- `settings.html`: the page the toolbar icon opens (accounts, engine token, backup).
- `src/annotate-core.js`: the logic of Deep analysis and Annotate chapter (Lichess's thresholds for ?!/?/??, the document its Publish takes, which results go on which move); tested by `scripts/annotate-test.mjs`. `src/features/annotate.js` is its bar; the analysis itself is `backend/deep_analysis.py`.
- `src/repertoire-index.js`: the repertoire looked up by position (transpositions); tested by `scripts/repertoire-test.mjs`.
- `src/features/*.js`: one file per feature.
- `vendor/chess.js`: chess.js 1.4.0 (BSD-2), to replay a study's moves into a position.
- `src/background.js`: talks to the app on 127.0.0.1:8001, starts the app, tells it every half minute that Lichess is still open, stops it when the last Lichess tab closes, replaces itself after a code change.
- `src/engine-select.js`: before Lichess starts, picks your Stockfish in Lichess's engine choice.
- `native/`: the start/stop helper Chrome runs, and `install.sh` that sets it up.
- `src/page-bridge.js`: runs in Lichess's page world (the only place that reaches Lichess's analysis controller) and carries out play-a-move, jump and Practice for the other scripts, and tells them the position in studies. It also paces the page's requests to Lichess's engine service, which refuses an address that asks too often; tested by `scripts/engine-pacing-test.mjs`.
- `scripts/engine_check.py`: asks Lichess's engine service for an analysis the way Lichess's page does, to test the engine link without a browser.
- `../backend/lichess_engine_provider.py`: the app side that serves your Stockfish to Lichess.
- `scripts/check.mjs`: the on-demand check.
- `scripts/real-extension.mjs`: the real extension in a separate headless Chrome, at each of Lichess's layout widths, and its settings page.
- `scripts/service-fuzz.py`: bad and simultaneous requests against a throwaway copy of the service and database.
- `TESTING.md`: how an agent hunts for bugs (the two scripts above are part of it); `REPAIR.md`: what to do when Lichess changes.
