// Your mistakes as exercises on Lichess's board. A mistake opens its game on
// the analysis board, stopped right before it; you play a move and your
// Stockfish (in the app) grades it, exactly like the app's Play tab. Shown in
// the left column, only while such an exercise is open.
(() => {
  const OX = globalThis.OX;
  const KEY = 'ox.mistake';

  const moveLabel = (ply, san) => `${Math.floor(ply / 2) + 1}${ply % 2 ? '…' : '.'} ${san}`;
  const pawns = cp => (cp >= 9000 ? 'winning' : cp <= -9000 ? 'lost'
    : `${cp > 0 ? '+' : cp < 0 ? '−' : ''}${(Math.abs(cp) / 100).toFixed(1)}`);
  OX.mistakeMoveLabel = moveLabel;
  OX.pawns = pawns;

  // Open `mistake` in its game, right before it; `queue` holds the ones after it.
  OX.startMistake = async (mistake, queue = [], label = '') => {
    const { path } = await OX.gamePath(mistake.game_id);
    try { localStorage.setItem(KEY, JSON.stringify({ mistake, queue, label, path })); } catch { /* blocked */ }
    if (decodeURIComponent(location.pathname) === decodeURIComponent(path)) {
      // Same game already open: only the "#move" would change, which doesn't
      // reload the page, so reload it to start the exercise.
      history.replaceState(null, '', `${path}#${mistake.ply}`);
      location.reload();
    } else {
      location.href = `${path}#${mistake.ply}`;
    }
  };

  function current() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      return saved && decodeURIComponent(location.pathname) === decodeURIComponent(saved.path) ? saved : null;
    } catch { return null; }
  }

  // The legal move from `fen` that reaches `key`, if any.
  function moveBetween(fen, key) {
    const chess = new globalThis.OXChess(fen);
    for (const move of chess.moves({ verbose: true })) {
      chess.move(move);
      const found = OX.positionKey(chess.fen()) === key;
      chess.undo();
      if (found) return move;
    }
    return null;
  }

  OX.defineFeature({
    id: 'mistake',
    name: 'Your mistake (exercise)',
    pages: ['analyse'],
    anchors: ['side'],
    needsPosition: true,
    order: 1,
    place: { anchor: 'side', where: 'append', zeroHeightOk: true },

    create(host, root) {
      root.classList.add('card');
      const state = current();
      if (!state) { root.style.display = 'none'; return {}; }
      const { mistake, queue } = state;
      const startKey = OX.positionKey(mistake.fen);
      let graded = null; // { key, result } for the answer being shown
      let checking = null;

      const status = OX.el('div', { class: 'row' });
      const buttons = OX.el('div', { class: 'btns' });
      root.append(
        OX.el('div', { class: 'head' },
          OX.el('span', { class: 'title' }, 'Your mistake'),
          OX.el('span', { class: 'grow' }),
          OX.el('span', { class: 'dim', text: state.label })),
        OX.el('div', { class: 'row' },
          'In your game you played ', OX.el('b', { text: moveLabel(mistake.ply, mistake.played_san) }),
          OX.el('span', { class: 'dim', text: ` (${pawns(mistake.cp_before)} → ${pawns(mistake.cp_after)})` }), '.'),
        status, buttons);

      const button = (text, onclick, primary) => OX.el('button', { class: `btn${primary ? ' primary' : ''}`, onclick, text });
      const toMistake = () => OX.lichess.jumpToPly(mistake.ply);
      const again = () => { graded = null; if (!toMistake()) location.reload(); render(); };
      const showBest = () => {
        const chess = new globalThis.OXChess(mistake.fen);
        const move = chess.move(mistake.best_san);
        if (!toMistake() || !OX.lichess.playUci(move.from + move.to + (move.promotion || ''))) {
          status.replaceChildren(`Stockfish's move: `, OX.el('b', { text: mistake.best_san }));
        }
      };
      const next = () => {
        const [following, ...rest] = queue;
        if (following) OX.startMistake(following.mistake, rest, following.label).catch(() => {});
      };

      function render() {
        const nexts = queue.length ? [button(`Next mistake (${queue.length} left)`, next)] : [];
        if (OX.state.position && OX.state.position.key !== startKey && !graded && !checking) {
          status.replaceChildren(OX.el('span', { class: 'dim', text: 'Elsewhere in the game. ' }),
            OX.el('button', { class: 'chip main', onclick: toMistake, text: 'Back to the mistake' }));
          buttons.replaceChildren(...nexts);
          return;
        }
        if (checking) {
          status.replaceChildren(OX.el('span', { class: 'dim', text: `Your Stockfish is checking ${checking}…` }));
          buttons.replaceChildren();
          return;
        }
        if (!graded) {
          status.replaceChildren(OX.el('b', { text: 'Find a better move.' }),
            OX.el('span', { class: 'dim', text: ' Play it on the board.' }));
          buttons.replaceChildren(button('Show the answer', showBest), ...nexts);
          return;
        }
        const r = graded.result;
        if (r.error) {
          status.replaceChildren(OX.el('span', { class: 'offline', text: r.error }));
        } else if (r.solved) {
          status.replaceChildren(OX.el('span', { class: 'ok' }, '✓ ', OX.el('b', { text: r.played_san }),
            r.cp == null ? ' — that is Stockfish\'s move.' : ` holds ${pawns(r.cp)} for you.`));
        } else {
          status.replaceChildren(OX.el('span', { class: 'bad' }, '✗ ', OX.el('b', { text: r.played_san }),
            ` leaves you at ${pawns(r.cp)}; you need ${pawns(r.target_cp)}.`));
        }
        buttons.replaceChildren(
          ...(r.solved ? [] : [button('Try again', again, true), button('Show the answer', showBest)]),
          button('Practice from here', () => OX.lichess.practice()),
          ...nexts);
      }

      async function grade(position) {
        if (position.key === startKey) { if (graded) graded = null; render(); return; }
        if (graded?.key === position.key || checking) return;
        const move = moveBetween(mistake.fen, position.key);
        if (!move) { if (!graded) render(); return; } // elsewhere in the game
        checking = move.san;
        render();
        let result;
        try {
          result = await OX.bridge.api('POST', `/mistakes/${mistake.id}/check`, { uci: move.from + move.to + (move.promotion || '') });
        } catch (error) {
          result = { error: error.offline ? OX.offlineText() : "Couldn't check the move." };
        }
        checking = null;
        graded = { key: position.key, result };
        render();
      }

      OX.lichess.showSide(mistake.user_color);
      render();
      return { update: position => { if (position) grade(position); }, destroy() {} };
    },
  });
})();
