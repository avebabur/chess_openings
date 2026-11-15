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
    // Put `color` at the bottom of the board (your side of your own game).
    showSide(color) {
      const black = document.querySelector('main.analyse .cg-wrap')?.classList.contains('orientation-black');
      return (color === 'black') === Boolean(black) || command('flip');
    },
  };
})();
