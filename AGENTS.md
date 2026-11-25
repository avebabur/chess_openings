# Openings for Lichess

Use Chrome at a normal desktop window size for extension development and QA. Skip mobile and narrow-viewport design, testing, debugging, and fixes unless the user explicitly asks for them. When a QA guide or suite includes those checks, skip them and run the applicable desktop checks.

## Checks and bugs (every change)

- `./check-all.sh` runs the fast checks (~10 s, nothing needs to run). It prints one line
  per check and details only for failures. It must end in `PASS` before you say a change
  is done. `./check-all.sh --full` adds the service fuzzer, the real extension headless
  and `check.mjs` (~3 min): run it once at the end of a bug hunt or a big change, not
  after every edit. The git pre-commit hook (`.githooks/`) runs the fast checks; never
  bypass it with `--no-verify`.
- **Every bug gets a failing test before its fix, and a row in `BUGS.md`.** `BUGS.md`
  says where the test goes. Read it before a bug hunt: it shows where bugs cluster and
  what was already fixed.
- When the user asks to fix the extension or test it for bugs, follow
  `extension/REPAIR.md` or `extension/TESTING.md`, the same as `CLAUDE.md` says.
