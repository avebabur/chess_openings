# Notes for agents

## The Lichess extension (`extension/`)

A Chrome extension that adds this app's features to lichess.org pages. Lichess changes its
site often, so features can stop showing. When the user asks to **fix the extension, the
Lichess errors, or "the errors"** (or `extension/health-report.json` lists anything under
`broken`), follow `extension/REPAIR.md` from step 1. Everything needed is there: how to see
what broke, where each feature belongs, the safety rules, and how to verify.

The app must be running (`./start.sh`, port 8001) for the extension and its check
(`node extension/scripts/check.mjs`) to work.
