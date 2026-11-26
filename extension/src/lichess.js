// Lichess's own analysis controller, for playing a move, jumping to a move or
// starting Practice exactly as Lichess's buttons do. The controller lives in
// the page's world; src/page-bridge.js (running there) carries out the action
// and reports back. Every call fails quietly (returns false): the boxes still
// show, only their buttons stop driving the board.
(() => {
  const OX = (globalThis.OX = globalThis.OX || {});

  function command(name, ...args) {
    const root = document.documentElement;
    root.removeAttribute('data-ox-result');
    document.dispatchEvent(new CustomEvent('ox-lichess', { detail: JSON.stringify({ name, args }) }));
    return root.getAttribute('data-ox-result') === '1';
  }

  OX.lichess = {
    playUci: uci => command('playUci', uci),
    playUciList: ucis => command('playUciList', ucis),
    jumpToPly: ply => command('jumpToMain', ply),
    toStart: () => command('userJump', ''),
    // Practice with computer from the current position (runs on your
    // Stockfish once it is Lichess's chosen engine).
    practice: () => command('practice'),
    flip: () => command('flip'),
    // Lichess's engine bar searches the position on the board again.
    restartCeval: () => command('restartCeval'),
    // The position on the board and the one the board started from, as
    // Lichess's controller holds them: { fen, start }, or null when the
    // controller can't be reached.
    position() {
      const root = document.documentElement;
      root.removeAttribute('data-ox-value');
      if (!command('position')) return null;
      try {
        const value = JSON.parse(root.getAttribute('data-ox-value'));
        root.removeAttribute('data-ox-value');
        return typeof value?.fen === 'string' && typeof value?.start === 'string' ? value : null;
      } catch { return null; }
    },
    // A study chapter's main line with the result Lichess holds for each
    // position (see page-bridge.js annotationData), or null.
    annotationData() {
      const root = document.documentElement;
      root.removeAttribute('data-ox-value');
      if (!command('annotationData')) return null;
      try {
        const value = JSON.parse(root.getAttribute('data-ox-value'));
        root.removeAttribute('data-ox-value');
        return Array.isArray(value?.nodes) ? value : null;
      } catch { return null; }
    },
    // Publishes an analysis to the study chapter (Lichess's own Publish).
    // Resolves to { status, message }; status 0 when it could not be sent.
    publishAnalysis(analysis) {
      return new Promise(resolve => {
        let timer = null;
        const done = event => {
          let detail = null;
          try { detail = JSON.parse(event.detail); } catch { return; }
          if (detail?.name !== 'publishAnalysis') return;
          clearTimeout(timer);
          document.removeEventListener('ox-lichess-reply', done);
          resolve({ status: Number(detail.status) || 0, message: String(detail.message || '') });
        };
        document.addEventListener('ox-lichess-reply', done);
        timer = setTimeout(() => {
          document.removeEventListener('ox-lichess-reply', done);
          resolve({ status: 0, message: 'Lichess did not answer' });
        }, 30000);
        if (!command('publishAnalysis', analysis)) {
          clearTimeout(timer);
          document.removeEventListener('ox-lichess-reply', done);
          resolve({ status: 0, message: 'Not a study chapter you can change' });
        }
      });
    },
    // Put `color` at the bottom of the board (your side of your own game).
    showSide(color) {
      const black = document.querySelector('main.analyse .cg-wrap')?.classList.contains('orientation-black');
      return (color === 'black') === Boolean(black) || command('flip');
    },
  };
})();
