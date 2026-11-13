// Your Stockfish in Lichess: makes Lichess's OWN engine bar, eval bar and
// "Practice with computer" run on your Mac's Stockfish (Lichess's official
// external engine, served by the app), so Lichess's in-browser Stockfish is
// never used. This box only shows when something needs you; once connected
// it is empty and invisible.
(() => {
  const OX = globalThis.OX;
  const VARIANT_KEYS = ['standard', 'fromPosition'];

  // Lichess keeps the chosen engine per variant in its own localStorage.
  // engine-select.js applies it before Lichess starts; this keeps it current.
  OX.lichessEngineChosen = () => {
    try { return localStorage.getItem('ceval.engine.standard'); } catch { return null; }
  };
  OX.chooseLichessEngine = id => {
    try {
      localStorage.setItem('ox.engineId', id);
      for (const variant of VARIANT_KEYS) localStorage.setItem(`ceval.engine.${variant}`, id);
    } catch { /* storage blocked: the user can pick it in Lichess's engine menu */ }
  };
  // Your Stockfish is no longer registered (token removed, Stockfish gone):
  // stop putting its id back on every page load, so Lichess's own choice holds.
  OX.forgetLichessEngine = () => {
    try { localStorage.removeItem('ox.engineId'); } catch { /* nothing saved then */ }
  };

  OX.defineFeature({
    id: 'engine',
    name: 'Your Stockfish in Lichess',
    pages: ['analyse'],
    anchors: ['ceval'],
    order: 1,
    place: { anchor: 'ceval', where: 'after', zeroHeightOk: true },

    create(host, root) {
      let status = null;
      let checkedAt = 0;
      let needsReload = false;

      const show = (...nodes) => {
        root.replaceChildren(...nodes);
        root.style.display = nodes.length ? '' : 'none';
      };

      function render() {
        const state = status?.state;
        if (state === 'ready' && status.engine_id) {
          if (OX.lichessEngineChosen() !== status.engine_id) {
            OX.chooseLichessEngine(status.engine_id);
            needsReload = true;
          }
          if (!needsReload) return show();
          return show(OX.el('div', { class: 'head' },
            OX.el('span', { class: 'grow', text: 'Your Stockfish is connected to Lichess.' }),
            OX.el('button', { class: 'link', onclick: () => location.reload(), text: 'Reload to use it' })));
        }
        if (state === 'app_offline') return show(OX.el('div', { class: 'offline', text: OX.offlineText() }));
        if (state === 'no_token' || state === 'missing_scope' || state === 'no_stockfish') OX.forgetLichessEngine();
        if (state === 'no_token' || state === 'missing_scope') {
          return show(
            OX.el('div', { class: 'title', text: 'Use your Stockfish here instead of Lichess’s' }),
            OX.el('div', { class: 'dim' },
              state === 'missing_scope' ? 'Your Lichess token has no engine access. ' : '',
              OX.el('a', { href: status.token_url, target: '_blank', rel: 'noopener', text: 'Create a Lichess token' }),
              ' (engine access is pre-ticked), then ',
              OX.el('button', { class: 'link', onclick: () => OX.bridge.openSettings(), text: 'open extension settings' }),
              ' to save it.'));
        }
        if (state === 'no_stockfish') return show(OX.el('div', { class: 'offline', text: 'Stockfish is not installed on this Mac.' }));
        if (state === 'off') return show();
        // Lichess can't be reached (the app keeps trying) or the app answered with an error.
        if (state === 'error') return show(OX.el('div', { class: 'offline', text: "Your Stockfish isn't connected to Lichess right now. Trying again…" }));
        return show(OX.el('div', { class: 'dim', text: 'Connecting your Stockfish to Lichess…' }));
      }

      async function refresh() {
        checkedAt = Date.now();
        try {
          status = await OX.bridge.api('GET', '/lichess-engine');
        } catch (error) {
          status = { state: error.offline ? 'app_offline' : 'error' };
        }
        render();
      }

      show();
      refresh();
      return {
        update() {},
        tick() {
          const every = status?.state === 'ready' ? 60_000 : 4000;
          if (Date.now() - checkedAt > every) refresh();
        },
        destroy() {},
      };
    },
  });
})();
