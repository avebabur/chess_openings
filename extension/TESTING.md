# Finding bugs in the extension

Instructions for an agent asked to **test the extension, find bugs, or run edge-case
checks**. (Lichess changed and a feature stopped showing? That is `REPAIR.md`.)

The existing checks already pass, so running them finds nothing new. Bugs are found by
the four passes below, in this order. Each pass catches what the others can't.

## Before you start

```bash
cp chess_review.db backups/chess_review-before-tests-$(date +%Y%m%d-%H%M).db   # backups/ is gitignored
git status --short        # another agent may be editing this folder: read its diff, never revert it
```

Then run what exists, once, to know the starting point, and read `BUGS.md` (repo root):
the areas with the most rows are where to look hardest, and what is listed there was
already fixed.

```bash
./check-all.sh --full     # every check; check.mjs needs the app on :8001
```

Every bug you find gets a failing test before its fix and a row in `BUGS.md` (it says
how). Run `./check-all.sh --full` once at the end, not after every fix.

## Pass 1: read the code and write down suspicions

Read every file in `src/` and `src/features/`, `settings.js`, and `backend/main.py`, in
full, before opening a browser. Start with `git diff` and `git log -5`: code changed
since the last commit is the least tested. While reading, write a list of things that
could be wrong. Questions that have found real bugs here:

- **Types across a boundary.** A value that went through `sessionStorage`, a URL, or JSON:
  is it still a number? (`"4742" === 4742` is false: a game id read back from
  `sessionStorage` once never matched.)
- **Patterns that match too much.** Every regex and selector: what else on Lichess fits?
  (`/training` has the shape of a game id; `a.user-link` also matches the spectator list.)
- **Limits on one side only.** A length or range the extension can exceed but the service
  refuses (a 700-character game address against `max_length=500`).
- **Two things at once.** Two clicks, two tabs, two requests, an answer that arrives after
  the page moved on. Look for read-then-write without a lock, and for buttons still on the
  page while their request is in flight.
- **State that outlives its page.** Module-level variables, caches, storage keys, timers:
  what do they hold after a navigation, a chapter switch, an extension reload?
- **What Lichess draws that you didn't expect.** Its own redraws, its settings views, its
  one- and two-column layouts, variants, studies, pages reached by redirect.

For each suspicion, note how you would see it. Then go and try each one.

## Pass 2: the real extension in the user's Chrome

The user's Chrome is left open for agents (Claude in Chrome tools; they are signed in to
Lichess). Open a new tab; the extension reloads itself after a code change on the next
Lichess page load, so **load a page twice** after editing.

**Measure instead of looking.** Paste this into the analysis tab, do things in a second
tab, then read `__log`. A box that vanishes for 0.1 s shows here and in no screenshot:

```js
window.__log = []; let last = ''; window.__t0 = Date.now();
setInterval(() => {
  const s = JSON.stringify({
    hosts: [...document.querySelectorAll('[data-ox-host]')].map(h => h.dataset.oxHost).join(','),
    myGames: !!document.querySelector('.ox-tab'),
    engine: (document.querySelector('.ceval')?.innerText || '').replace(/\s+/g, ' ').slice(0, 60),
  });
  if (s !== last) { last = s; __log.push(((Date.now() - __t0) / 1000).toFixed(2) + ' ' + s); }
}, 50);
```

Read a box's text (they are in shadow roots):
`document.querySelector('[data-ox-host=repertoire]').shadowRoot.querySelector('.ox').innerText`.
Drive the board with Lichess's own controller: `site.analysis.playUciList(['e2e4','e7e5'])`,
`site.analysis.userJump('')`, `site.analysis.flip()`. Use **real** clicks and typing for
anything about focus or keyboard shortcuts; `.click()` from script is fine for logic.

**After every action, look where the user can't:**

```bash
tail -20 ~/Library/Logs/openings-app.log                 # any 4xx/5xx the page swallowed?
curl -s http://127.0.0.1:8001/api/lichess-engine         # state, and `recent`: every engine request
cat extension/health-report.json                         # what the extension says is broken
```

**Do each thing the wrong way too:**

- click twice and three times, fast (Save, Delete, Extend, Sync, More games, Check);
- type before the suggestion has arrived, press Enter, Escape, `f`, arrow keys in a text box;
- click the tab that is already open, open settings on top of it, close them in the other order;
- act in two tabs at once; change something in one and use the other;
- reload in the middle (a save, a sync, an Annotate chapter publish), go Back, switch study chapters;
- stop the app in the middle with `./stop.sh` from the repository root. Signalling
  the launchd job alone can leave its backend process running.

**Lichess's engine, for as long as a real review takes.** One position proves nothing:
Lichess's engine service refuses an address that asks too often, and it took a quarter of a
minute of stepping to get there ("Your Stockfish error: TypeError: Failed to fetch"). Step
through a long game the way a person does and count the failures:

```js
window.__fails = []; const real = window.fetch;   // on top of the extension's own wrapper
window.fetch = (...a) => real(...a).catch(e => { if (String(a[0]).includes('external-engine') && e.name !== 'AbortError') __fails.push(String(e)); throw e; });
site.analysis.userJump('');
for (let i = 1; i <= 90; i++) { site.analysis.jumpToMain(i % 60); site.analysis.redraw(); await new Promise(r => setTimeout(r, 400)); }
[__fails, document.querySelectorAll('.engine-error').length, site.analysis.ceval.state]   // [], 0, and not 4 (failed)
```

Never measure that limit by sending the service requests of your own: it is Lichess's
server, and the numbers are in `REPAIR.md`.

**Use the extremes of the real data**, not `e4 e5`: the longest game
(`sqlite3 chess_review.db "select id, length(pgn) from games order by 2 desc limit 3"`),
every page of My games, a position past move 20, promotion, en passant, castling, mate, a
repetition, a line saved for both colours, a name with `<b>`, quotes, `&` and an emoji.

**Pages to cover:** `/analysis`, `/analysis/pgn/…`, a set-up position
(`/analysis/standard/<fen>`), a variant (`/analysis/crazyhouse`), your own finished game,
someone else's finished game, a study (switch chapters, open the explorer), `/practice/…`,
and plain pages in a second tab (`/training`, `/practice`, `/streamer`) while watching the
log above for a blink.

**Game pages stay clean** (there is no cross-tab lock: other tabs keep working):

1. `lichess.org/tv/classical` and a real game (Play → *Play against computer*, level 1,
   unlimited; **abort before the first move** with the ✖ under the moves): no
   `[data-ox-host]` on the page at any moment, and an analysis tab next to it keeps its boxes.
2. Before aborting, open the round's analysis link: a forecast board (correspondence) must
   show nothing of the extension either; for a game against the computer Lichess sends you
   back to the game page.

## Pass 3: what the user's Chrome can't show

```bash
node extension/scripts/real-extension.mjs     # the real extension, headless, fresh profile
```

This checks the desktop layouts and the settings page (`chrome-extension://` pages
can't be opened through Claude in Chrome). Since Nov 2026 Lichess shows headless
Chrome a Cloudflare "verify you are human" page: both browser scripts then print
`skip` for the real Lichess pages (never get round the check) and still run every
check on local copies. The layouts are then only checked in pass 2. Both browser scripts run desktop checks
by default. Set `OX_CHECK_NARROW=1` only when the user asks to test narrow layouts.
Screenshots: `extension/check-output/real-*.png`; look at them. This copy of the extension
uses its own temporary fixture server, so it never changes the user’s data.

## Pass 4: attack the service

```bash
venv/bin/python extension/scripts/service-fuzz.py
```

Bad input on every route, a thousand requests at once, and simultaneous changes to one
repertoire line, against its own service on a **copy** of the database (port 8011). Any
500, traceback or leftover row fails it. When you add a route or a field, add its bad
inputs to `bad_input()` there.

## When something looks wrong

- **Find the cause before calling it a bug or dismissing it.** Repeat it under conditions
  that remove the innocent explanation (a script move like `playUci('c2c4')` for the wrong
  side makes an impossible position that the app and Lichess both refuse with 400). When it depends on Lichess, read Lichess's
  source (`https://raw.githubusercontent.com/lichess-org/lila/master/…`) instead of guessing.
- **Not a bug of ours:** Lichess runs its engine in one tab at a time; the size of a
  study's chapter list and chat is the user's own dragging, stored by Lichess.
- **Every fix gets a check** that fails without it: a fixture page in `scripts/check.mjs`
  (see `studyAnnotate`, `/ox-fixture/explorer`), a test in
  `backend/tests/`, a case in `scripts/engine-pacing-test.mjs` or `scripts/repertoire-test.mjs`,
  or a line in `service-fuzz.py`. Then confirm the fix in the real Chrome.
- Fix the cause in the smallest place; keep every Lichess selector in `src/anchors.js`; the
  safety rules in `REPAIR.md` (step 4) hold for fixes too. Bump `version` in `manifest.json`.
- Restart the app after backend changes: `launchctl kickstart -k gui/$(id -u)/com.openings.app`.

## Leave things as you found them

Delete the repertoire lines you saved for testing and compare the counts with the backup
(`select count(*) from repertoire_branches`, `… repertoire_nodes`). Close the tabs you
opened. Never sign out, never bypass Lichess's bot check, never play moves in a real game.
Run all the suites once more at the end, not after every change.

## Report

One line per finding, most serious first: what the user would see, how to make it happen,
the cause (file and line), whether it is fixed, and which check now covers it. Say what
you did **not** test. "No bugs found" is only worth saying together with the list of what
was tried.

## Two agents

Two agents running the same checks find the same nothing. Split it:

- **One attacks** (passes 1, 2 and 4) and writes its findings and suspicions down before
  fixing anything.
- **The other reviews**: reads that list and the diff, tries to break each fix, runs
  pass 3 and all the suites, and looks for what the first one's list has no entry for.
- Swap roles next time. Both work in this folder at once, so read `git status` and
  `git diff` before committing, and commit only when the suites pass on the combined tree.
