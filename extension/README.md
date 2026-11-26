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
| Left column (the WikiBook is hidden) | **Your game** | When you open one of your games from My games, or open one of your own Lichess games: who, when and the result (a chess.com game; Lichess already shows them for its own), and **Practice from here** against your Stockfish. A Lichess game opens on its own Lichess page (computer analysis, notes), a chess.com game on the analysis board. A game you just played that the app hasn't imported yet has **Sync games**. |
| Under the move list, in your study chapters | **Annotate chapter** | You step through the moves with your Stockfish and press **+** where you want it deeper; the bar counts how many moves have a result ("21 of 24"), links the ones that don't yet and the shallowest one. When every move has a result, **Annotate chapter** publishes them to the chapter, the same request as Lichess's "Analyse on your device" → Publish, and Lichess marks the moves itself: ?!, ?, ??, "X was best" with its line, the accuracy chart. Go deeper on a move later and press **Annotate again** to update the marks. It uses the results Lichess already keeps for that chapter (your engine's, or Lichess's cloud where it used it); nothing runs in the background. |
| Left column | **Repertoire** | Saved lines for the board position appear automatically, with the current move order first. Use **Edit** to change a line's name, type, or moves. Play the new move order on the board, choose **Use board moves**, and save the changes. **Manage saved lines** searches the whole repertoire by moves or name. Each saved line can also be deleted or extended. |
| Left column, under the repertoire | **Opening explorer** | Lichess's explorer moved from the right column (which keeps the engine and moves). Its **My games** tab replaces Lichess's Player tab (on variant boards, where My games has nothing, Lichess's Player tab stays): your chess.com and Lichess games as one history, newest first; it shows the side at the bottom of the board, and **As white ⇄** switches. Results are green for a win and red for a loss. **Sync games** brings in your newest games from every account. |

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

## Fair play: it switches itself off during games

- While **any** Lichess tab shows a game in progress (yours or one you're watching, Lichess
  TV included), every feature in every Lichess tab is removed, and your Stockfish answers
  Lichess with no new analysis or best move. Lichess can still display its cached evaluations.
  Stockfish is quiet. The toolbar icon
  shows **live**. Everything comes back when the game's result appears, and Lichess's
  engine bar searches the position on the board again by itself.
- This fails safe: a game page counts as live until its result box shows; a game tab that
  goes straight into the next game (rematch) stays locked in between; after an extension
  update or a Chrome restart every open Lichess tab is checked before anything is shown;
  the app starts with your Stockfish paused and serves Lichess only once the extension
  has said no game is on (a second or two after it starts).
- If the app stops unexpectedly while Lichess is open, the extension starts it again within
  half a minute, and the boxes and Lichess's engine bar recover by themselves.
- What it can't see: a game in another browser or Chrome profile, or a correspondence game
  whose page isn't open.

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

It opens real Lichess pages, runs the extension in them, tests the live-game switch, and
prints what's showing. To fix, hand an agent `extension/REPAIR.md`.

## Files

- `src/anchors.js`: every Lichess selector the extension uses. Repairs happen here.
- `src/core.js`: page detection, the live-game lock, placing features, health reports.
- `src/page.css`: the few styles applied to Lichess's own page (hidden WikiBook, explorer in the left column).
- `src/styles.js`: the styles of the added boxes (inside their shadow roots).
- `settings.html`: the page the toolbar icon opens (accounts, engine token, backup).
- `src/annotate-core.js`: Annotate chapter's logic (Lichess's thresholds for ?!/?/??, the document its Publish takes); tested by `scripts/annotate-test.mjs`. `src/features/annotate.js` is its bar.
- `src/repertoire-index.js`: the repertoire looked up by position (transpositions); tested by `scripts/repertoire-test.mjs`.
- `src/features/*.js`: one file per feature.
- `vendor/chess.js`: chess.js 1.4.0 (BSD-2), to replay a study's moves into a position.
- `src/background.js`: talks to the app on 127.0.0.1:8001, keeps the lock across tabs, starts the app, tells it every half minute that Lichess is still open, stops it when the last Lichess tab closes, replaces itself after a code change.
- `src/engine-select.js`: before Lichess starts, picks your Stockfish in Lichess's engine choice.
- `native/`: the start/stop helper Chrome runs, and `install.sh` that sets it up.
- `src/page-bridge.js`: runs in Lichess's page world (the only place that reaches Lichess's analysis controller) and carries out play-a-move, jump and Practice for the other scripts, and tells them the position in studies. It also paces the page's requests to Lichess's engine service, which refuses an address that asks too often; tested by `scripts/engine-pacing-test.mjs`.
- `scripts/engine_check.py`: asks Lichess's engine service for an analysis the way Lichess's page does, to test the engine link without a browser.
- `../backend/lichess_engine_provider.py`: the app side that serves your Stockfish to Lichess.
- `scripts/check.mjs`: the on-demand check.
- `scripts/real-extension.mjs`: the real extension in a separate headless Chrome, at each of Lichess's layout widths, and its settings page.
- `scripts/service-fuzz.py`: bad and simultaneous requests against a throwaway copy of the service and database.
- `TESTING.md`: how an agent hunts for bugs (the two scripts above are part of it); `REPAIR.md`: what to do when Lichess changes.
