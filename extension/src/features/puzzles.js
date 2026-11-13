// "Your mistakes" on Lichess's puzzle page: the mistakes your app found in
// your own games, trained one at a time on Lichess's board (see mistake.js).
(() => {
  const OX = globalThis.OX;
  const SHOWN = 6;

  OX.defineFeature({
    id: 'puzzles',
    name: 'Your mistakes (puzzle page)',
    pages: ['puzzle'],
    anchors: ['puzzleTools'],
    order: 1,
    place: { anchor: 'puzzleTools', where: 'append' },

    create(host, root) {
      root.classList.add('card');
      const body = OX.el('div', { class: 'row dim', text: 'Loading…' });
      root.append(OX.el('div', { class: 'head' }, OX.el('span', { class: 'title' }, 'Your mistakes')), body);
      let polling = null;

      const opponent = game => (game.user_color === 'white' ? game.black : game.white);

      async function load() {
        let data;
        let analysis;
        try {
          [data, analysis] = await Promise.all([
            OX.bridge.api('GET', '/mistakes'), OX.bridge.api('GET', '/analysis')]);
        } catch (error) {
          body.replaceChildren(OX.el('span', { class: 'offline', text: error.offline ? OX.offlineText() : "Couldn't load your mistakes." }));
          return;
        }
        // Unsolved first, newest game first.
        const all = data.games.flatMap(game => game.mistakes.map(mistake => ({ mistake, label: `vs ${opponent(game)}` })));
        const todo = [...all.filter(x => x.mistake.progress.last_result !== 'solved'),
          ...all.filter(x => x.mistake.progress.last_result === 'solved')];
        const start = index => {
          const [first, ...rest] = todo.slice(index);
          OX.startMistake(first.mistake, rest, first.label).catch(() => {});
        };
        const analyse = OX.el('button', {
          class: 'btn',
          onclick: async () => {
            try { await OX.bridge.api('POST', '/analysis', { count: 20 }); } catch { /* shown on reload */ }
            load();
          },
          text: 'Check my 20 newest games',
        });
        const progress = analysis.running
          ? OX.el('div', { class: 'row dim', text: `Your Stockfish is checking your games: ${analysis.done} of ${analysis.total} done…` })
          : null;
        clearTimeout(polling);
        if (analysis.running) polling = setTimeout(load, 4000);

        if (!all.length) {
          body.className = '';
          body.replaceChildren(
            OX.el('div', { class: 'row dim', text: `From your own games. ${data.games_analysed} of ${data.games_total} games checked so far; no mistakes found yet.` }),
            progress || OX.el('div', { class: 'btns' }, analyse));
          return;
        }
        body.className = '';
        body.replaceChildren(
          OX.el('div', { class: 'row dim', text: `From your own games: ${all.length} mistakes, ${data.solved} solved · ${data.games_analysed} of ${data.games_total} games checked.` }),
          OX.el('div', { class: 'btns' },
            OX.el('button', { class: 'btn primary', onclick: () => start(0), text: 'Train my mistakes' }),
            progress ? null : analyse),
          progress,
          OX.el('div', { class: 'mistakes' }, todo.slice(0, SHOWN).map((x, i) => OX.el('div', {
            class: 'mistake', title: 'Train this one', onclick: () => start(i),
          },
          OX.el('span', { class: 'san', text: OX.mistakeMoveLabel(x.mistake.ply, x.mistake.played_san) }),
          OX.el('span', { class: 'dim grow', text: x.label }),
          OX.el('span', { class: x.mistake.progress.last_result === 'solved' ? 'ok' : 'dim',
            text: x.mistake.progress.last_result === 'solved' ? '✓' : `${OX.pawns(x.mistake.cp_before)} → ${OX.pawns(x.mistake.cp_after)}` })))));
      }

      load();
      // Arriving from "From my games" in the Puzzles menu: bring the box into view.
      if (location.hash === '#ox-mistakes') setTimeout(() => host.scrollIntoView({ block: 'center', behavior: 'smooth' }), 600);
      return { update() {}, destroy() { clearTimeout(polling); } };
    },
  });
})();
