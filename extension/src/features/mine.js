// "My games" replaces Lichess's Player tab in the opening explorer. It combines
// imported Lichess and chess.com games, showing the moves you played
// from this position and your games that reached it (newest first, so at the
// start position it is your whole history). Built from Lichess's own markup
// (table.moves, table.games, div.bar) so it looks the same. A move plays on
// the board; a game opens on the analysis board at this position.
(() => {
  const OX = globalThis.OX;
  const A = OX.anchors;
  const PAGE = 15;

  function bar(white, draws, black) {
    const sum = white + draws + black || 1;
    const part = (cls, n) => {
      const percent = (n * 100) / sum;
      return OX.el('span', {
        class: cls, style: `width: ${Math.round((n * 1000) / sum) / 10}%`,
        text: percent > 12 ? Math.round(percent) + (percent > 20 ? '%' : '') : '',
      });
    };
    return OX.el('div', { class: 'bar' }, part('white', white), part('draws', draws), part('black', black));
  }
  // Your wins/draws/losses as Lichess's White / Draw / Black.
  const wdb = (row, color) => (color === 'white' ? [row.win, row.draw, row.loss] : [row.loss, row.draw, row.win]);
  // Lichess's own result pill and speed icons (lila explorerView.ts showResult,
  // lib/game/perfIcons.ts; the glyphs are Lichess's icon font).
  // The score is written as always (1-0 is a win for White); the pill's colour
  // says how it went for YOU: green won, red lost.
  const result = (r, you) => {
    const drawn = r !== '1-0' && r !== '0-1';
    const won = !drawn && (r === '1-0') === (you === 'white');
    return OX.el('result', {
      class: `${r === '1-0' ? 'white' : r === '0-1' ? 'black' : 'draws'}${drawn ? '' : won ? ' ox-won' : ' ox-lost'}`,
      title: drawn ? 'Draw' : won ? 'You won' : 'You lost',
      text: r === '1/2-1/2' ? '½-½' : r,
    });
  };
  // The side at the bottom of the board: the one you are looking from.
  const boardSide = () =>
    (document.querySelector('main.analyse .cg-wrap')?.classList.contains('orientation-black') ? 'black' : 'white');
  const SPEED_ICON = { bullet: '\ue032', blitz: '\ue008', rapid: '\ue002', classical: '\ue00a', daily: '\ue019' };
  const speedIcon = s => OX.el('i', { 'data-icon': SPEED_ICON[s] || '', title: s ? s[0].toUpperCase() + s.slice(1) : '' });

  OX.defineFeature({
    id: 'mine',
    name: 'My games tab (explorer)',
    pages: ['analyse'],
    anchors: ['explorerTitle'],
    optional: true,
    needsPosition: true,
    order: 1,
    place: {
      anchor: 'explorerTitle', tag: 'button', shadow: false,
      custom(title, host) {
        const gear = title.querySelector('.toconf');
        if (gear) { if (host.parentNode !== title || host.nextSibling !== gear) title.insertBefore(host, gear); }
        else if (host.parentNode !== title) title.append(host);
      },
    },

    create(host) {
      // All of the tab's state first.
      const content = OX.el('div', { class: 'ox-mine-content' });
      let position = null;
      let loadedKey = null;
      let nodes = null;
      let color = null;
      let chosen = null;        // the side picked with the switch, until the board is flipped
      let side = boardSide();
      let games = [];
      let total = 0;
      let token = 0;
      const open = () => !!OX.settings.mineOpen;

      host.type = 'button';
      host.className = 'button-link ox-tab text';
      host.dataset.icon = '\ue050'; // Lichess's person icon, as on its Player tab
      host.title = 'Your games from chess.com and Lichess, as one history';
      // The label never changes (the side is shown, and switched, inside the
      // tab): a label that grew to "My games as white" pushed the other tabs
      // about and was cut off.
      host.replaceChildren('My games');

      // The side shown follows the board (your side is at the bottom), unless
      // that side has no games here and the other has, or you switched.
      const pickSide = () => {
        const other = side === 'white' ? 'black' : 'white';
        color = chosen || (!nodes[side].total_games && nodes[other].total_games ? other : side);
      };
      const switchSide = () => {
        chosen = color === 'white' ? 'black' : 'white';
        color = chosen;
        reloadGames();
      };

      host.addEventListener('click', event => {
        event.stopPropagation();
        // Like Lichess's Player tab: clicking it again switches sides.
        if (open() && nodes) return switchSide();
        OX.setSetting('mineOpen', true);
        sync();
        if (position && loadedKey !== position.key) load(position);
      });
      // Choosing one of Lichess's own tabs leaves "My games".
      const leave = event => {
        if (!host.contains(event.target) && open()) { OX.setSetting('mineOpen', false); sync(); }
      };
      let listeningTitle = null;

      function sync() {
        host.classList.toggle('ox-active', open());
        const box = OX.$(A.explorerBox.selector);
        if (!box) return;
        box.classList.toggle('ox-mine', open());
        const title = OX.$(A.explorerTitle.selector);
        if (title && title !== listeningTitle) {
          listeningTitle?.removeEventListener('click', leave, true);
          title.addEventListener('click', leave, true);
          listeningTitle = title;
        }
        const data = title?.parentElement;
        if (data && content.parentNode !== data) data.append(content);
      }

      const empty = text => OX.el('div', { class: 'ox-empty', text });

      // Sync games: brings in your newest games, then shows them here.
      let syncNote = '';
      const syncButton = OX.el('button', {
        type: 'button', class: 'ox-sync text', 'data-icon': '\ue078', // Lichess's reload icon
        title: 'Bring in your newest games from chess.com and Lichess', text: 'Sync',
      });
      const showNote = text => {
        syncNote = text;
        const note = content.querySelector('.ox-mine-note');
        if (note) note.textContent = text;
      };
      syncButton.addEventListener('click', async event => {
        event.stopPropagation();
        syncButton.disabled = true;
        try {
          const count = await OX.syncGames(showNote);
          showNote(OX.syncedText(count));
          if (count && position) { loadedKey = null; await load(position); }
        } catch (error) {
          showNote(OX.syncErrorText(error));
        }
        syncButton.disabled = false;
        setTimeout(() => { if (!syncButton.disabled && syncNote) { syncNote = ''; if (nodes) render(); } }, 6000);
      });

      function render() {
        const node = nodes[color];
        const s = node.summary || {};
        const other = color === 'white' ? 'black' : 'white';
        // The name of the position on the board (from the ECO list), not of
        // the openings your games through it ended up in.
        const opening = node.opening_name || '';
        const summary = node.total_games
          ? `${node.total_games} game${node.total_games === 1 ? '' : 's'} · you score ${Math.round(s.score)}%${opening ? ` · ${opening}` : ''}`
          : '';
        const head = OX.el('div', { class: 'ox-mine-head' },
          OX.el('button', {
            type: 'button', class: 'ox-side', title: `Showing your games as ${color}. Click for your games as ${other}.`,
            onclick: event => { event.stopPropagation(); switchSide(); },
          }, OX.el('strong', { text: `As ${color}` }), ' ⇄'),
          OX.el('span', { class: 'ox-mine-note', title: summary || null, text: syncNote || summary }),
          syncButton);
        if (!node.total_games) {
          content.replaceChildren(head, empty(`No games as ${color} here.`));
          return;
        }
        const sum = node.moves.reduce((n, m) => n + m.games, 0) || 1;
        const moves = node.moves.length ? OX.el('table', { class: 'moves' },
          OX.el('thead', {}, OX.el('tr', {},
            OX.el('th', { text: 'Move' }), OX.el('th', { colspan: 2, text: 'Games' }), OX.el('th', { text: 'White / Draw / Black' }))),
          OX.el('tbody', {}, node.moves.map(m => OX.el('tr', {
            'data-uci': m.uci, title: `Your score ${Math.round(m.score)}% — click to play ${m.san}`,
            onclick: () => OX.lichess.playUci(m.uci),
          },
          OX.el('td', { text: m.san }),
          OX.el('td', { text: `${Math.round((m.games * 100) / sum)}%` }),
          OX.el('td', { text: String(m.games) }),
          OX.el('td', {}, bar(...wdb(m, color))))))) : null;
        const list = games.length ? OX.el('table', { class: 'games' },
          OX.el('thead', {}, OX.el('tr', {}, OX.el('th', { class: 'title', colspan: 5, text: `Your games, newest first (${total})` }))),
          OX.el('tbody', {}, games.map(g => {
            const you = g.user_color;
            const ratings = you === 'white' ? [g.user_rating, g.opp_rating] : [g.opp_rating, g.user_rating];
            return OX.el('tr', {
              'data-id': g.id, title: 'Open this game at this position',
              onclick: () => OX.openMyGame(g.id, g.ply).catch(() => {}),
            },
            OX.el('td', { class: 'game-rating' }, OX.el('span', { text: ratings[0] ?? '' }), OX.el('span', { text: ratings[1] ?? '' })),
            OX.el('td', {}, OX.el('span', { text: g.white }), OX.el('span', { text: g.black })),
            OX.el('td', {}, result(g.result, you)),
            OX.el('td', { class: 'game-date', text: (g.date || '').slice(0, 10).replace(/\./g, '-') }),
            OX.el('td', { class: 'game-type' }, speedIcon(g.time_class)));
          }))) : null;
        const more = games.length < total
          ? OX.el('button', { class: 'ox-more', onclick: loadMore, text: 'More games' })
          : null;
        content.replaceChildren(...[head, moves, list, more].filter(Boolean));
      }

      async function fetchGames(offset) {
        const query = new URLSearchParams({ fen: position.fen, color, limit: PAGE, offset });
        return OX.bridge.api('GET', `/position-games?${query}`);
      }

      async function reloadGames() {
        const mine = ++token;
        try {
          const res = await fetchGames(0);
          if (mine !== token) return;
          games = res.games;
          total = res.total;
          render();
        } catch { /* keep what is shown */ }
      }

      let loadingMore = false;
      async function loadMore() {
        if (loadingMore) return; // a second click would add the same games twice
        loadingMore = true;
        const mine = token;
        const res = await fetchGames(games.length).catch(() => null);
        loadingMore = false;
        if (!res || mine !== token) return;
        games.push(...res.games);
        total = res.total;
        render();
      }

      async function load(next) {
        const mine = ++token;
        loadedKey = next.key;
        content.replaceChildren(empty('Loading your games…'));
        try {
          // The moves on the board, so the position gets the name Lichess
          // would give it (the deepest named opening on the way).
          const moves = (OX.currentLine() || []).join(' ');
          const [white, black] = await Promise.all(['white', 'black'].map(c =>
            OX.bridge.api('GET', `/opening-tree?${new URLSearchParams({ color: c, fen: next.fen, moves_san: moves })}`)));
          if (mine !== token) return;
          nodes = { white, black };
          pickSide();
          const res = await fetchGames(0);
          if (mine !== token) return;
          games = res.games;
          total = res.total;
          render();
        } catch (error) {
          if (mine !== token) return;
          loadedKey = null;
          content.replaceChildren(empty(error.offline ? OX.offlineText() : "Couldn't load your games."));
        }
      }

      return {
        update(next) {
          position = next;
          if (open() && next && next.key !== loadedKey) load(next);
        },
        tick() {
          // The native Player tab is hidden. If Lichess selected it, show the
          // combined My games view instead of an inaccessible tab's content.
          if (!open() && OX.$('main.analyse .explorer-title .active.player')) {
            OX.setSetting('mineOpen', true);
            if (position && loadedKey !== position.key) load(position);
          }
          // The board was flipped: show that side's games.
          const now = boardSide();
          if (now !== side) {
            side = now;
            chosen = null;
            if (open() && nodes) { pickSide(); reloadGames(); }
          }
          sync();
        },
        destroy() {
          token++;
          listeningTitle?.removeEventListener('click', leave, true);
          content.remove();
          OX.$(A.explorerBox.selector)?.classList.remove('ox-mine');
        },
      };
    },
  });
})();
