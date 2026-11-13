// Runs before Lichess's own scripts: makes Lichess's analysis use your
// Stockfish (registered by the app) instead of its in-browser one. The id is
// saved by features/engine.js once the app reports the engine is connected.
try {
  const id = localStorage.getItem('ox.engineId');
  if (id) {
    for (const variant of ['standard', 'fromPosition']) {
      if (localStorage.getItem(`ceval.engine.${variant}`) !== id) {
        localStorage.setItem(`ceval.engine.${variant}`, id);
      }
    }
  }
} catch { /* storage blocked: nothing to do */ }
