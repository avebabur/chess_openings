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
    // Put `color` at the bottom of the board (your side of your own game).
    showSide(color) {
      const black = document.querySelector('main.analyse .cg-wrap')?.classList.contains('orientation-black');
      return (color === 'black') === Boolean(black) || command('flip');
    },
  };
})();
