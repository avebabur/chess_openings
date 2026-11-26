# Bug log

Every bug found by an agent, a test or by hand gets a row here. Newest go at the top
of the table.

**Why:** the log stops the same bug from being found and fixed twice. It shows where
bugs cluster, so the next bug hunt knows where to look. It also shows when to stop:
when a whole round finds only `low` bugs, the app is in good shape.

## The rule (for every agent)

1. **Test first.** Before fixing a bug, write a test that fails because of it. Put it in
   the closest existing test file: `backend/tests/` for the service, or
   `extension/scripts/*-test.mjs` for extension logic. If only the real page in Chrome
   can show the bug, the test goes in `check.mjs` / `real-extension.mjs`.
2. **Fix it.** The new test passes.
3. **Run `./check-all.sh`.** It must end in `PASS`. Run `./check-all.sh --full` before
   saying a bug hunt or a big change is done.
4. **Add a row below.** In the Test column, name the file that now catches the bug.
   Write `none: <reason>` only when no automated test can see it, e.g. it is only
   visible in a real signed-in Lichess page.

Severity:
- `high`: the extension acts during a live game, data is lost or wrong, or a crash.
- `med`: a feature does not work.
- `low`: wording, looks, or small inconvenience.

Area is one of: `lock` (the live-game lock, removed in 0.19.0: game pages simply show nothing), `engine`, `repertoire`, `my-games`, `sync`,
`settings`, `service`, `layout`.

## Log

The rows before 2026-11-16 were collected from the commit messages. `?` in the Test
column means it is not known which test, if any, covers the bug. Replace a `?` when
you find the test or write one.

| Date | Area | Sev | Bug | Found by | Test |
|---|---|---|---|---|---|
| 2026-11-26 | my-games | med | Space on a focused My games button (More games, a move or game row, Sync, the side switch, the tab) also reached Lichess's Space shortcut: it played the engine's best move, the board moved on and the list reloaded for the new position. My games sits in Lichess's page, not in a shadow root; Space now stays with its buttons | real Chrome, keyboard | `check.mjs` (pagination fixture) |
| 2026-11-26 | layout | low | After Annotate chapter published one chapter, its "Annotated…" (or refusal) message stayed under the move list in every other chapter you switched to; it now belongs to the chapter it was about | code review, then a fixture | `check.mjs` (study fixture) |
| 2026-11-26 | engine | med | Annotate chapter counted results Lichess restores from its browser cache, including depth-1 lines of searches cancelled after 1 ms (stepping quickly), as "analysed": a chapter could show 88 of 88 and publish nonsense ?/?? marks. Results below depth 12 (mates excepted) now count as missing and are listed with their depth | real Chrome (study r4Fn1nW3) | `annotate-test.mjs` |
| 2026-11-26 | service | low | Editing, starring or deleting a line another tab had deleted said "This line changed": the service answered 409 for a missing line whenever the request carried what it expected (every request from the extension does). It now answers 404 and the box says the line was deleted in another tab | real Chrome, two tabs | `test_api.py`, `check.mjs` |
| 2026-11-26 | layout | low | `real-extension.mjs` and `check.mjs` reported the analysis board missing (or crashed) once Lichess began showing headless Chrome its Cloudflare bot check; they now say those pages were skipped and run the rest on local copies | `./check-all.sh --full` | `real-extension.mjs`, `check.mjs` |
| 2026-11-26 | layout | low | The new Annotate chapter bar printed "nullnull" under its button: empty lines passed as null to replaceChildren(), which writes them as text | real Chrome before release | none: only visible in a real Lichess page |
| 2026-11-25 | engine | med | Study analysis stopped sharp positions at depth 26-27, below the promised 32: each position had at most 120 s, and the position after 11. g4 in a real game needs about 300 s on four threads. The cap is now 600 s | real run in Chrome | none: depends on real Stockfish's speed on this Mac |
| 2026-11-25 | service | med | "Try again" on a failed study game would have imported it into the study a second time. It now keeps its chapter and the positions already analysed; a chapter Lichess no longer has (404) is added anew | code review during the real run | none: the study analysis was removed in 0.18.0 (its test with it) |
| 2026-11-25 | service | med | Lichess refused to publish a study analysis ("nodesPerMove error.expected.int"): the cloud's node counts, billions at depth 60-75, were averaged in. Now only your engine's nodes count, capped to a 32-bit number | real publish to Lichess | none: the study analysis was removed in 0.18.0 (its test with it) |
| 2026-11-17 | engine | med | Stepping through a game still showed "Loading engine" for whole moves after about 22 new positions: every position went through Lichess's engine broker (three requests against its per-address limit). Now the page's request is answered by the app on this computer (no broker), with the broker as fallback | measured in real Chrome | `engine-pacing-test.mjs`, `live-lock-test.mjs`, `test_lichess_engine_provider.py` |
| 2026-11-17 | engine | med | Stepping through moves showed "Loading engine" for whole moves: opening positions with a cloud evaluation were still sent to your Stockfish (Lichess stops it only after the first line), so 14 opening moves used up the request allowance and the middlegame was paced from move 23 | user, measured in real Chrome | `engine-pacing-test.mjs` |
| 2026-11-16 | engine | med | Stepping through a game at clicking speed asked Lichess's engine service too often; Lichess showed "Your Stockfish error: TypeError: Failed to fetch" | hand test | `engine-pacing-test.mjs` |
| 2026-11-15 | engine | med | "Check with your Stockfish" waited forever for a game opened from My games (id from sessionStorage was text, compared with a number) | real Chrome | ? |
| 2026-11-15 | lock | high | Opening Puzzles, Practice or Streamers in another tab locked every tab for a moment (addresses look like game ids); a half-typed save form was lost | real Chrome | ? |
| 2026-11-15 | lock | med | A player's TV page did not count as a game address | real Chrome | ? |
| 2026-11-15 | service | med | Health reports from a game opened from My games were refused (address over 500 characters) | real Chrome | ? |
| 2026-11-15 | sync | med | "Sync games" was offered on someone else's game because Lichess lists you among its spectators | real Chrome | ? |
| 2026-11-15 | repertoire | low | Save this line: the suggested name was not selected, so typing did not replace it | real Chrome | ? |
| 2026-11-15 | repertoire | low | A second click on Delete said "That didn't work" about a delete that worked | real Chrome | ? |
| 2026-11-15 | my-games | low | Closing Lichess's explorer settings left My games | real Chrome | ? |
| 2026-11-15 | service | high | Two saves of the same new line at once gave a 500 and could leave moves without a line | service fuzz | `service-fuzz.py` |
| 2026-11-15 | service | med | An id too large for SQLite gave a 500 instead of a 422 | service fuzz | `test_api.py`, `service-fuzz.py` |
| 2026-11-15 | sync | med | The sync hid partial failures | test | `sync-test.mjs` |
| 2026-11-15 | repertoire | med | En passant was missing from position keys | test | `test_position_key.py` |
| 2026-11-14 | engine | high | During a live game your Stockfish left Lichess's requests unanswered; the broker timed out and Lichess showed "Error loading engine" | hand test | `test_lichess_engine_provider.py` |
| 2026-11-14 | engine | med | After the lock lifted, Lichess's engine bar did not search again and Practice hung on "Computer thinking…" | hand test | ? |
| 2026-11-14 | engine | med | Checking games for mistakes kept running during a live game | hand test | ? |
| 2026-11-14 | my-games | low | Opening a Lichess game from My games did not land on its last move | hand test | ? |
| 2026-11-14 | lock | high | A rematch (game tab straight into the next game) unlocked other tabs for a moment | headless Chrome | `live-lock-test.mjs` |
| 2026-11-14 | lock | high | An extension update or Chrome restart emptied session storage, so other tabs unlocked mid-game | headless Chrome | `live-lock-test.mjs` |
| 2026-11-14 | lock | high | A page whose background script did not answer at start counted as unlocked | headless Chrome | `live-lock-test.mjs` |
| 2026-11-14 | engine | high | Your Stockfish kept serving Lichess's engine bar during games | headless Chrome | `test_lichess_engine_provider.py` |
| 2026-11-14 | repertoire | high | "Save this line" on a board set up from a position saved the moves as if played from the start | headless Chrome | ? |
| 2026-11-14 | sync | med | Games against the computer or anonymous players were imported with blank names | headless Chrome | `test_game_import.py` |
| 2026-11-14 | repertoire | med | Rename did not work while the lines filter was on; typing left the box | hand test | ? |
| 2026-11-14 | repertoire | low | The lines list lost its scroll after rename, star and delete | hand test | ? |
| 2026-11-14 | my-games | low | My games named the position after the commonest opening of its games, not the ECO name | hand test | ? |
| 2026-11-14 | settings | low | A username with a space or "/" showed a bare 422 | hand test | ? |
| 2026-11-14 | settings | low | Remove-account and remove-token confirmations had no Cancel and did not reset | hand test | ? |
| 2026-11-14 | settings | low | Sync in settings did not report its result on the account's row | hand test | ? |
| 2026-11-14 | repertoire | med | The out-of-repertoire warning looked at the wrong part of the line and at both sides | hand test | ? |
| 2026-11-14 | service | med | POST /api/analysis for a game that does not exist did not answer 404 | hand test | `test_api.py` |
| 2026-11-14 | repertoire | med | Lines that reach the same position by another move order were not shown (transpositions) | hand test | `repertoire-test.mjs` |
