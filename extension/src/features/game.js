// One of your games: who, when, the result, and the mistakes your app found
// in it, in the left column. Shown on the analysis board of a game opened
// from My games, and on the page of one of your own Lichess games (there
// Lichess already shows who and when, so only the mistakes). A game not yet
// checked gets a button to check just that one game with your Stockfish.
(() => {
  const OX = globalThis.OX;
  const KEY = 'ox.game';

  // The analysis-board address of one of your games (its moves in the URL).
  function gamePath(game) {
    const chess = new globalThis.OXChess();
    chess.loadPgn(game.pgn || '', { strict: false });
    const sans = chess.history().map(san => san.replace(/[+#]/g, ''));
    return { path: `/analysis/pgn/${sans.map(encodeURIComponent).join('_')}`, plies: sans.length };
  }

  // Opens your game at `ply` (default: the end). A game played on Lichess
  // opens on its own Lichess page, from your side, with everything Lichess
  // keeps for it (computer analysis, the eval graph, your notes, the chat). A
  // chess.com game has no Lichess page, so it opens on the analysis board.
  OX.openMyGame = async (gameId, ply) => {
    const game = await OX.bridge.api('GET', `/games/${gameId}`);
    const lichessId = game.source === 'lichess'
      && /\[(?:GameId "|Site "https?:\/\/lichess\.org\/(?:game\/)?)([A-Za-z0-9]{8})"/.exec(game.pgn || '')?.[1];
    if (lichessId) {
      location.href = `/${lichessId}${game.user_color === 'black' ? '/black' : ''}${ply == null ? '' : `#${ply}`}`;
      return;
    }
    const { path, plies } = gamePath(game);
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
      if (!accounts.length) throw new Error('No game accounts yet. Click the extension icon to add one.');
      onProgress('Syncing your games…');
      let jobs = await Promise.all(accounts.map(a => OX.bridge.api('POST', `/accounts/${a.id}/sync`)));
      const started = Date.now();
      while (jobs.some(j => j.status === 'queued' || j.status === 'running')) {
        if (Date.now() - started > 5 * 60 * 1000) throw new Error('The sync is taking longer than expected. Check its progress in extension settings.');
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

  const moveLabel = (ply, san) => `${Math.floor(ply / 2) + 1}${ply % 2 ? '…' : '.'} ${san}`;
  // An evaluation as Lichess writes it, from White's side: +1.3, −0.4, #3 (White
  // mates in 3), #-3, and 1-0 / 0-1 for a position that is simply won (the
  // tablebase's verdict, or mate on the board). The app stores evaluations
  // from YOUR side (10000 = won, 10000 − n = mate in n), so Black's are turned round.
  const evalText = (cp, color) => {
    const white = color === 'black' ? -cp : cp;
    const size = Math.abs(white);
    if (size >= 10000) return white > 0 ? '1-0' : '0-1';
    if (size >= 9000) return `#${white > 0 ? '' : '-'}${10000 - size}`;
    const pawns = (size / 100).toFixed(1);
    return `${pawns === '0.0' ? '' : white > 0 ? '+' : '−'}${pawns}`;
  };
  const seconds = n => (n >= 90 ? `${Math.round(n / 60)} min` : `${Math.max(5, Math.round(n / 5) * 5)} s`);

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
    place: { anchor: 'side', where: 'append', zeroHeightOk: true, tab: true },

    create(host, root) {
      root.classList.add('card');
      const saved = current();
      // A Lichess game page: /abcd1234, /abcd1234/black, /game/abcd1234.
      const onLichessGame = !saved && !!OX.lichessGameId();
      root.style.display = 'none';
      if (!saved && !onLichessGame) return {};
      const body = OX.el('div', { class: 'dim', text: 'Loading your game…' });
      root.append(body);
      // Its tab (features/sidetabs.js) appears once there is something to show.
      let alive = true;
      const show = () => { root.style.display = ''; OX.sidePanel.set('game', { available: true }); };
      let gameId = saved?.id;
      let polling = null;
      let wanted = true; // load() is still to run (first time, or again once the app is back)

      async function find() {
        if (gameId) return gameId;
        try {
          gameId = (await OX.bridge.api('GET', `/games/by-link?url=${encodeURIComponent(location.origin + location.pathname)}`)).id;
        } catch (error) {
          if (error.offline) wanted = true;
          gameId = null; // not one of your imported games: show nothing
        }
        return gameId;
      }

      // Checks this game, saying how far it has got: "Checking… move 12 of 48,
      // about 25 s left", or which game is being checked first.
      async function checkThisGame(button) {
        button.disabled = true;
        button.textContent = 'Starting the check…';
        try {
          await OX.bridge.api('POST', '/analysis', { game_id: gameId });
        } catch (error) {
          button.textContent = error.offline ? OX.offlineText() : "Couldn't start the check.";
          return;
        }
        let ownSince = 0;     // when this game's turn came
        let ownStartedAt = 0; // ...and how many moves were done then
        const wait = async () => {
          const status = await OX.bridge.api('GET', '/analysis').catch(() => null);
          if (!alive) return;
          // Not heard this time (the app busy, or restarting): ask again.
          if (!status) { polling = setTimeout(wait, 2000); return; }
          const own = status?.running && status.game_id === gameId;
          // Done: nothing is running any more, or the run has moved on to another game.
          if (!status?.running || (ownSince && !own)) return load();
          if (own) {
            const { moves_done: done, moves_total: total } = status;
            if (!ownSince) { ownSince = Date.now(); ownStartedAt = done; }
            const rate = (done - ownStartedAt) / ((Date.now() - ownSince) / 1000);
            const left = done - ownStartedAt >= 3 && rate > 0 ? `, about ${seconds((total - done) / rate)} left` : '';
            button.textContent = total ? `Checking… move ${Math.min(done + 1, total)} of ${total}${left}` : 'Checking…';
          } else {
            button.textContent = `Waiting: checking ${status.title || 'another game'} first…`;
          }
          polling = setTimeout(wait, 1000);
        };
        polling = setTimeout(wait, 500);
      }

      // A Lichess game of yours the app hasn't imported yet (just played):
      // offer to sync, then show its card.
      async function offerSync() {
        let accounts;
        try { accounts = await OX.bridge.api('GET', '/accounts'); } catch { return; }
        if (!alive) return;
        const names = accounts.filter(a => a.platform === 'lichess').map(a => a.username.toLowerCase());
        const players = [...document.querySelectorAll('a.user-link[href^="/@/"]')]
          .map(a => decodeURIComponent(a.getAttribute('href').slice(3)).split(/[/?#]/)[0].toLowerCase());
        if (!names.some(name => players.includes(name))) return; // not one of your games
        const button = OX.el('button', { class: 'btn primary', text: 'Sync games' });
        const note = OX.el('div', { class: 'dim', text: "This game isn't in My games yet." });
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
        show();
        body.className = '';
        body.replaceChildren(note, OX.el('div', { class: 'btns' }, button));
      }

      async function load() {
        wanted = false;
        if (!(await find())) {
          if (onLichessGame && !wanted && alive) offerSync();
          return;
        }
        let game;
        try {
          game = await OX.bridge.api('GET', `/games/${gameId}`);
        } catch (error) {
          if (!alive) return;
          if (error.offline) wanted = true;
          show();
          body.replaceChildren(OX.el('span', { class: 'offline', text: error.offline ? OX.offlineText() : "Couldn't load the game." }));
          return;
        }
        if (!alive) return;
        show();
        if (!onLichessGame) OX.lichess.showSide(game.user_color);
        const result = resultFor(game);
        const opponent = (game.user_color === 'white' ? game.black : game.white) || 'the computer';
        const label = `vs ${opponent}`;
        const mistakes = game.mistakes || [];
        // A row jumps to the position before the mistake.
        const list = mistakes.map(m => OX.el('div', {
          class: 'mistake',
          title: "Go to the position before this move.\nThe evaluation before → after it, from White's side, as on Lichess's bar.",
          onclick: () => OX.lichess.jumpToPly(m.ply),
        },
        OX.el('span', { class: 'san', text: moveLabel(m.ply, m.played_san) }),
        OX.el('span', { class: 'dim grow', text: `${evalText(m.cp_before, game.user_color)} → ${evalText(m.cp_after, game.user_color)}` }),
        OX.el('span', { class: 'dim', text: `best ${m.best_san}` })));
        const check = OX.el('button', { class: 'btn primary', text: 'Check with your Stockfish' });
        check.addEventListener('click', () => checkThisGame(check));
        const rating = value => (value ? ` (${value})` : '');
        body.className = '';
        body.replaceChildren(
          // Lichess's own game page already says who played and when.
          ...(onLichessGame ? [] : [
            OX.el('div', { class: 'head' },
              OX.el('span', { class: 'title grow ellipsis', text: `${label}${rating(game.opp_rating)}` }),
              OX.el('b', { class: result.cls, text: result.text })),
            OX.el('div', { class: 'dim small', text: [`You${rating(game.user_rating)} as ${game.user_color}`, game.time_class, game.date].filter(Boolean).join(' · ') }),
            game.opening ? OX.el('div', { class: 'dim small ellipsis', title: OX.openingName(game.opening), text: OX.openingName(game.opening) }) : null,
          ].filter(Boolean)),
          OX.el('div', { class: 'subhead', style: onLichessGame ? 'margin-top: 0' : null }, 'Your mistakes',
            mistakes.length ? OX.el('span', { class: 'dim', text: String(mistakes.length) }) : null),
          mistakes.length
            ? OX.el('div', { class: 'list' }, list)
            : OX.el('div', { class: 'dim row', text: game.mistakes_analyzed_at ? 'Your Stockfish found none in this game.' : 'Not checked yet.' }),
          // Stays in view while a long list of mistakes scrolls.
          OX.el('div', { class: 'btns sticky' },
            game.mistakes_analyzed_at ? null : check,
            OX.el('button', {
              class: 'btn', title: "Lichess's Practice with computer, on your Stockfish, from the position on the board",
              onclick: () => OX.lichess.practice(), text: 'Practice from here',
            })),
        );
      }

      return {
        // Runs once the box is on the page, on every move, and when the app
        // comes back after being down: only load when there is something to.
        update() { if (wanted) load(); },
        destroy() { alive = false; clearTimeout(polling); OX.sidePanel.set('game', { available: false }); },
      };
    },
  });
})();
