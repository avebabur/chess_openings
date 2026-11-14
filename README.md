# Openings for Lichess

A Chrome extension that adds your repertoire, your combined Chess.com and Lichess games with the mistakes found in them, and your local Stockfish to Lichess. The local FastAPI service stores your data in SQLite and runs only as the extension’s data and engine provider. There is no standalone web app.

## Use

1. Load `extension/` as an unpacked extension in Chrome.
2. Run `sh extension/native/install.sh` once for automatic service startup.
3. Open Lichess. Click the extension icon for accounts, Lichess engine token, and a SQLite backup.

See [extension/README.md](extension/README.md) for the full feature map and setup details.

## Local service

`./start.sh` starts the API on `127.0.0.1:8001`; `./stop.sh` stops it. The native helper starts it when a Lichess page opens and stops it when the last one closes; if Chrome quits or crashes first, the service stops itself after two minutes (`backend/idle_exit.py`). Python dependencies are installed into `venv` when needed. Stockfish is detected automatically, or can be set with `STOCKFISH_PATH`. Games and repertoire are in `chess_review.db`; keep that file and any backups private.

## Development

The backend lives in `backend/`, the extension in `extension/`. The extension browser check is `node extension/scripts/check.mjs` after `npm install --prefix extension/scripts`. It uses real Lichess pages in Chrome. `node extension/scripts/repertoire-test.mjs` tests the repertoire's transposition handling and needs nothing running. Backend tests: `./venv/bin/python -m pytest backend/tests`.
