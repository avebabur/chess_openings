# Openings for Lichess (Chrome extension)

Adds your openings tools to lichess.org itself. You keep playing on the real Lichess,
and the app's features sit inside Lichess's own pages, in Lichess's colours (light, dark
and transparent themes all match).

The extension gets data from the local service. You don't need to start it: opening
Lichess starts it (after the one-time `sh extension/native/install.sh`).

## What it adds

| Where on Lichess | Feature | What it does |
|---|---|---|
| Lichess's own engine bar, eval bar and "Practice with computer" | **Your Stockfish in Lichess** | Lichess's engine runs on your Mac's Stockfish 19 through Lichess's official "external engine", so only one Stockfish runs. Lichess's engine settings (search time 8 s by default, lines, memory) apply. Practice answers as Lichess asks: normal Practice in about a second, Mastery mode in your search time (8 s by default; lower it in Lichess's engine settings for faster replies). `OPENINGS_PRACTICE_SECONDS` forces a fixed time. A small box under the engine bar appears only when something needs you. |
| Left column (the WikiBook is hidden) | **Your game** | When you open one of your games from My games, or open one of your own Lichess games: the My game tab lists the mistakes your Stockfish found, each with the better move; a row jumps to that position. A Lichess game opens on its own Lichess page (computer analysis, notes), a chess.com game on the analysis board. A game not checked yet has **Check with your Stockfish**, which shows how far it has got (move 12 of 48, about 20 s left). The settings page can check all unchecked games. Evaluations are from White's side, as on Lichess's bar. A game you just played that the app hasn't imported yet has **Sync games**. Practice from here vs your Stockfish. |
| Left column | **Repertoire** | Per colour: your move here (main line marked) or the moves you're ready for, and your main line onward; **Lines through here** with play-the-rest, rename, main/sideline and delete (lines that share a name show the moves that tell them apart); **Extend** a line you've played past; **Save this line**; a warning saying where the game left the repertoire of the side at the bottom of the board. Everything is looked up by position, so a position reached by another move order shows what you prepared for it, and a line can be extended from there. Everything the app's Repertoire tab did for managing lines. |
| Left column, under the repertoire | **Opening explorer** | Lichess's explorer moved from the right column (which keeps the engine and moves). Its **My games** tab replaces Lichess's Player tab: your chess.com and Lichess games as one history, newest first; it shows the side at the bottom of the board, and **As white ⇄** switches. Results are green for a win and red for a loss. **Sync games** brings in your newest games from every account. |

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

- While **any** Lichess tab shows a game in progress (yours or one you're watching), every
  feature in every Lichess tab is removed and the engine stops. The toolbar icon shows
  **live**. Everything comes back when the game's result appears.
- This fails safe: a game page counts as live until its result box shows.

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
- `src/page.css`: the few styles applied to Lichess's own page (board colours, hidden WikiBook, explorer in the left column).
- `src/styles.js`: the styles of the added boxes (inside their shadow roots).
- `settings.html`: the page the toolbar icon opens (accounts, checking games for mistakes, engine token, backup).
- `src/repertoire-index.js`: the repertoire looked up by position (transpositions); tested by `scripts/repertoire-test.mjs`.
- `src/features/*.js`: one file per feature.
- `vendor/chess.js`: chess.js 1.4.0 (BSD-2), to replay a study's moves into a position.
- `src/background.js`: talks to the app on 127.0.0.1:8001, keeps the lock across tabs, starts the app, tells it every half minute that Lichess is still open, stops it when the last Lichess tab closes, replaces itself after a code change.
- `src/engine-select.js`: before Lichess starts, picks your Stockfish in Lichess's engine choice.
- `native/`: the start/stop helper Chrome runs, and `install.sh` that sets it up.
- `src/page-bridge.js`: runs in Lichess's page world (the only place that reaches Lichess's analysis controller) and carries out play-a-move, jump and Practice for the other scripts.
- `scripts/engine_check.py`: asks Lichess's engine service for an analysis the way Lichess's page does, to test the engine link without a browser.
- `../backend/lichess_engine_provider.py`: the app side that serves your Stockfish to Lichess.
- `scripts/check.mjs`: the on-demand check.
