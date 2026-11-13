// One of your games: who, when, the result, and the mistakes your app found
// in it, in the left column. Shown on the analysis board of a game opened
// from My games, and on the page of one of your own Lichess games (there
// Lichess already shows who and when, so only the mistakes). A game not yet
// checked gets a button to check just that one game with your Stockfish.
(() => {
  const OX = globalThis.OX;
  const KEY = 'ox.game';

  // The analysis-board address of one of your games (its moves in the URL).
  OX.gamePath = async gameId => {
    const game = await OX.bridge.api('GET', `/games/${gameId}`);
    const chess = new globalThis.OXChess();
    chess.loadPgn(game.pgn || '', { strict: false });
    const sans = chess.history().map(san => san.replace(/[+#]/g, ''));
    return { path: `/analysis/pgn/${sans.map(encodeURIComponent).join('_')}`, plies: sans.length };
  };

  // Opens your game on Lichess's analysis board, at `ply` (default: the end).
  OX.openMyGame = async (gameId, ply) => {
    const { path, plies } = await OX.gamePath(gameId);
    try { localStorage.setItem(KEY, JSON.stringify({ id: gameId, path })); } catch { /* blocked */ }
    location.href = `${path}#${ply ?? plies}`;
  };

  // Brings in your newest games from every account (chess.com and Lichess),
  // as the app's Sync button does. Resolves with how many new games came in;
  // onProgress(text) is told what is happening. The app checks new games for
  // mistakes on its own after a sync.
  let syncing = null;
  OX.syncGames = (onProgress = () => {}) => {
    if (syncing) return syncing;
    syncing = (async () => {
      const accounts = await OX.bridge.api('GET', '/accounts');
      if (!accounts.length) throw new Error('No accounts in the app yet: add one in the app first.');
      onProgress('Syncing your games…');
      let jobs = await Promise.all(accounts.map(a => OX.bridge.api('POST', `/accounts/${a.id}/sync`)));
      const started = Date.now();
      while (jobs.some(j => j.status === 'queued' || j.status === 'running')) {
        if (Date.now() - started > 5 * 60 * 1000) throw new Error('The sync is taking long; it carries on in the app.');
        await new Promise(resolve => setTimeout(resolve, 1500));
        jobs = await Promise.all(jobs.map(j => (j.status === 'queued' || j.status === 'running'
          ? OX.bridge.api('GET', `/sync-jobs/${j.id}`) : j)));
        const seen = jobs.reduce((n, j) => n + (j.seen || 0), 0);
        if (seen) onProgress(`Syncing your games… ${seen} looked at`);
      }
      const failed = jobs.filter(j => j.status === 'failed');
      if (failed.length === jobs.length) throw new Error(failed[0].error || "The sync didn't work.");
      return jobs.reduce((n, j) => n + (j.imported || 0), 0);
    })().finally(() => { syncing = null; });
    return syncing;
  };
  OX.syncedText = count => (count ? `${count} new game${count === 1 ? '' : 's'} synced` : 'Up to date: no new games');
  OX.syncErrorText = error => (error.offline ? OX.offlineText() : error.status ? "Couldn't sync your games." : error.message);

  function current() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      return saved && decodeURIComponent(location.pathname) === decodeURIComponent(saved.path) ? saved : null;
    } catch { return null; }
  }

  const resultFor = (game) => {
    if (game.result === '1/2-1/2') return { text: 'Draw', cls: 'dim' };
    const won = (game.result === '1-0') === (game.user_color === 'white');
    return won ? { text: 'Won', cls: 'ok' } : { text: 'Lost', cls: 'bad' };
  };

  OX.defineFeature({
    id: 'game',
    name: 'Your game',
    pages: ['analyse'],
    anchors: ['side'],
    order: 2,
    place: { anchor: 'side', where: 'append', zeroHeightOk: true },

    create(host, root) {
      root.classList.add('card');
      const saved = current();
      // A Lichess game page: /abcd1234, /abcd1234/black, /game/abcd1234.
      const onLichessGame = !saved && /^\/(game\/)?[A-Za-z0-9]{8}(\/(white|black))?\/?$/.test(location.pathname);
      root.style.display = 'none';
      if (!saved && !onLichessGame) return {};
      const title = OX.el('span', { class: 'title' }, onLichessGame ? 'Your mistakes in this game' : 'Your game');
      const body = OX.el('div', { class: 'row dim', text: 'Loading your game…' });
      root.append(OX.el('div', { class: 'head' }, title), body);
      let gameId = saved?.id;
      let polling = null;

      async function find() {
        if (gameId) return gameId;
        try {
          gameId = (await OX.bridge.api('GET', `/games/by-link?url=${encodeURIComponent(location.href)}`)).id;
        } catch { gameId = null; } // not one of your imported games: show nothing
        return gameId;
      }

      async function checkThisGame(button) {
        button.disabled = true;
        button.textContent = 'Your Stockfish is checking this game…';
        try {
          await OX.bridge.api('POST', '/analysis', { game_id: gameId });
        } catch (error) {
          button.textContent = error.offline ? OX.offlineText() : "Couldn't start the check.";
          return;
        }
        // Reload the card when the check is done (about 30–60 s a game).
        const wait = async () => {
          const status = await OX.bridge.api('GET', '/analysis').catch(() => null);
          if (status?.running) { polling = setTimeout(wait, 3000); return; }
          load();
        };
        polling = setTimeout(wait, 3000);
      }

      // A Lichess game of yours the app hasn't imported yet (just played):
      // offer to sync, then show its card.
      async function offerSync() {
        let accounts;
        try { accounts = await OX.bridge.api('GET', '/accounts'); } catch { return; }
        const names = accounts.filter(a => a.platform === 'lichess').map(a => a.username.toLowerCase());
        const players = [...document.querySelectorAll('a.user-link[href^="/@/"]')]
          .map(a => decodeURIComponent(a.getAttribute('href').slice(3)).split(/[/?#]/)[0].toLowerCase());
        if (!names.some(name => players.includes(name))) return; // not one of your games
        const button = OX.el('button', { class: 'btn primary', text: 'Sync games' });
        const note = OX.el('div', { class: 'dim', text: "This game isn't in your app yet." });
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const count = await OX.syncGames(text => { note.textContent = text; });
            note.textContent = OX.syncedText(count);
            if (await find()) { load(); return; }
            note.textContent = `${OX.syncedText(count)}, but not this game yet: Lichess can take a minute to list it.`;
          } catch (error) {
            note.textContent = OX.syncErrorText(error);
          }
          button.disabled = false;
        });
        root.style.display = '';
        body.className = '';
        body.replaceChildren(note, OX.el('div', { class: 'btns' }, button));
      }

      async function load() {
        if (!(await find())) {
          if (onLichessGame) offerSync();
          return;
        }
        let game;
        try {
          game = await OX.bridge.api('GET', `/games/${gameId}`);
        } catch (error) {
          root.style.display = '';
          body.replaceChildren(OX.el('span', { class: 'offline', text: error.offline ? OX.offlineText() : "Couldn't load the game." }));
          return;
        }
        root.style.display = '';
        if (!onLichessGame) OX.lichess.showSide(game.user_color);
        const white = `${game.white}${game.user_color === 'white' ? ' (you)' : ''} ${game.user_color === 'white' ? game.user_rating ?? '' : game.opp_rating ?? ''}`;
        const black = `${game.black}${game.user_color === 'black' ? ' (you)' : ''} ${game.user_color === 'black' ? game.user_rating ?? '' : game.opp_rating ?? ''}`;
        const result = resultFor(game);
        const opponent = game.user_color === 'white' ? game.black : game.white;
        const label = `vs ${opponent}`;
        const mistakes = game.mistakes || [];
        const list = mistakes.map((m, i) => OX.el('div', {
          class: 'mistake',
          title: 'Go to the position before this move',
          onclick: () => OX.lichess.jumpToPly(m.ply),
        },
        OX.el('span', { class: 'san', text: OX.mistakeMoveLabel(m.ply, m.played_san) }),
        OX.el('span', { class: 'dim grow', text: `${OX.pawns(m.cp_before)} → ${OX.pawns(m.cp_after)} · best ${m.best_san}` }),
        OX.el('button', {
          class: 'chip', title: 'Train this mistake',
          onclick: event => {
            event.stopPropagation();
            OX.startMistake(m, mistakes.slice(i + 1).map(next => ({ mistake: next, label })), label).catch(() => {});
          },
          text: 'Train',
        })));
        const check = OX.el('button', { class: 'btn primary', text: 'Check this game with your Stockfish' });
        check.addEventListener('click', () => checkThisGame(check));
        body.className = '';
        body.replaceChildren(
          ...(onLichessGame ? [] : [
            OX.el('div', { class: 'row' }, OX.el('span', { text: `${white.trim()} – ${black.trim()} · ` }),
              OX.el('b', { class: result.cls, text: result.text })),
            OX.el('div', { class: 'dim', text: [game.time_class, game.date, game.opening].filter(Boolean).join(' · ') }),
            OX.el('div', { class: 'row title', text: 'Your mistakes' }),
          ]),
          mistakes.length
            ? OX.el('div', { class: 'mistakes' }, list)
            : game.mistakes_analyzed_at
              ? OX.el('div', { class: 'dim', text: 'Your Stockfish found no mistakes in this game.' })
              : OX.el('div', {}, OX.el('div', { class: 'dim', text: 'Not checked for mistakes yet.' }), OX.el('div', { class: 'btns' }, check)),
          OX.el('div', { class: 'btns' }, OX.el('button', {
            class: 'btn', onclick: () => OX.lichess.practice(), text: 'Practice from here vs your Stockfish',
          })),
        );
      }

      load();
      return { update() {}, destroy() { clearTimeout(polling); } };
    },
  });
})();
