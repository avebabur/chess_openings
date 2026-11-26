// Deep analysis + Annotate chapter, under the move list in a study chapter.
//
// While a chapter is open, its main line is sent to the app every 1.5 s
// (POST /api/deep-analysis, backend/deep_analysis.py), which analyses every
// position by itself on your Stockfish: 90 seconds each with no depth limit
// (an endgame goes as deep as Stockfish can, up to its maximum, depth 245);
// Lichess's cloud where it already has depth 38 (the opening).
// Each finished result is put on its move (page-bridge.js setEvals), so the
// engine bar and its arrows show it there. Lichess's engine bar comes first:
// the analysis waits while it searches.
//
// In a chapter you can change, once every move has its result, the analysis
// is published to the chapter by itself (Lichess's own Publish, as after
// "Analyse on your device"), and Lichess marks the moves: ?!, ?, ??, "X was
// best", the accuracy chart. It is published again only if the chapter or a
// result changes. "Annotate chapter" publishes at once with what there is.
//
// The logic is src/annotate-core.js; the page side is page-bridge.js.
(() => {
  const OX = globalThis.OX;
  const POLL_MS = 1500;
  const SHOW_MISSING = 6;
  const PAUSED_KEY = id => `ox.deepPaused.${id}`;
  const PUBLISHED_KEY = id => `ox.deepPublished.${id}`;

  const refusal = ({ status, message }) => {
    if (status === 423) return "Lichess's own server analysis of this chapter is still running. Try again when it is done.";
    if (status === 401 || status === 403) return 'Only members of the study who can change it can annotate it.';
    if (status === 404) return 'Lichess no longer has this chapter.';
    if (!status) return `Couldn't reach Lichess (${message || 'no answer'}).`;
    return `Lichess refused it (${status}${message ? `: ${message.slice(0, 120)}` : ''}).`;
  };
  const stored = (store, key) => { try { return store.getItem(key); } catch { return null; } };
  const store = (s, key, value) => {
    try { if (value == null) s.removeItem(key); else s.setItem(key, value); } catch { /* storage blocked */ }
  };
  const minutes = seconds => (seconds < 90 ? `${Math.max(1, Math.round(seconds))} s` : `${Math.round(seconds / 60)} min`);

  OX.defineFeature({
    id: 'annotate',
    name: 'Deep analysis',
    pages: ['analyse'],
    anchors: ['moveList'],
    order: 6,
    place: { anchor: 'moveList', where: 'after', zeroHeightOk: true },

    create(host, root) {
      root.classList.add('card', 'annotate');
      root.style.display = 'none';
      if (!OX.isStudy()) return {};
      let alive = true;
      let timer = null;
      let shown = '';      // what is on screen, to redraw only on a change
      let busy = false;    // publishing
      let note = null;     // { text, cls, chapterId } after a publish, shown in that chapter only
      let deep = null;     // { chapterId, status } the app's last answer
      let offline = false;
      let asking = false;
      let sent = '';       // the results last put on the moves
      let tried = '';      // the signature last published by itself (even if refused)

      const jump = ply => () => OX.lichess.jumpToPly(ply);
      const chip = (label, ply, title) => OX.el('button', { type: 'button', class: 'link', title, onclick: jump(ply), text: label });
      const engineId = () => stored(localStorage, 'ox.engineId');
      const results = data => (deep && deep.chapterId === data.chapterId ? deep.status.results : []);
      const merged = data => OX.annotate.withResults(data, results(data), engineId());

      async function annotate(data, automatic = false) {
        busy = true;
        const { chapterId } = data;
        const signature = OX.annotate.signature(data);
        if (automatic) tried = signature;
        note = { text: 'Publishing your analysis…', cls: 'dim', chapterId };
        render(true);
        let answer;
        try {
          answer = await OX.lichess.publishAnalysis(OX.annotate.build(data));
        } catch (error) {
          answer = { status: 0, message: error.message };
        }
        busy = false;
        const ok = answer.status >= 200 && answer.status < 300;
        if (ok) store(localStorage, PUBLISHED_KEY(chapterId), signature);
        note = ok
          ? { text: 'Annotated. Lichess is adding its marks to the moves.', cls: 'ok', chapterId }
          : { text: refusal(answer), cls: 'bad', chapterId };
        render(true);
      }

      // Send the chapter, take what is done, put it on the moves.
      async function analyse() {
        if (asking) return;
        const data = OX.lichess.annotationData();
        const ask = OX.annotate.chapterRequest(data, data && stored(sessionStorage, PAUSED_KEY(data.chapterId)) === '1');
        if (!ask) return;
        asking = true;
        try {
          const status = await OX.bridge.api('POST', '/deep-analysis', ask);
          offline = false;
          deep = { chapterId: ask.pageId, status };
        } catch (error) {
          offline = !!error.offline;
          if (!offline) deep = null;
        } finally {
          asking = false;
        }
        if (!alive || !deep) return render();
        const evals = OX.annotate.engineEvals(deep.status.results);
        const key = JSON.stringify([deep.chapterId, evals.map(e => [e.ply, e.nodes])]);
        if (key !== sent && OX.lichess.setEvals(evals)) sent = key;
        render();
        autoPublish();
      }

      function autoPublish() {
        if (busy || !deep || deep.status.state !== 'done') return;
        const data = OX.lichess.annotationData();
        if (!data || !data.canContribute || data.chapterId !== deep.chapterId) return;
        const full = merged(data);
        if (!OX.annotate.status(full).ready) return;
        const signature = OX.annotate.signature(full);
        if (signature === tried || signature === stored(localStorage, PUBLISHED_KEY(data.chapterId))) return;
        annotate(full, true);
      }

      function togglePause(chapterId, paused) {
        store(sessionStorage, PAUSED_KEY(chapterId), paused ? null : '1');
        analyse();
      }

      function deepLines(data) {
        if (offline) return [OX.el('div', { class: 'offline small', text: OX.offlineText() })];
        if (!deep || deep.chapterId !== data.chapterId) return [OX.el('div', { class: 'dim small', text: 'Deep analysis: starting…' })];
        const s = deep.status;
        const paused = s.state === 'paused';
        const rule = `${s.target.seconds} s each, or the cloud's depth ${s.target.cloudDepth}+`;
        const label = ply => {
          const node = data.nodes.find(n => n.ply === ply);
          return !node || !node.san ? 'the starting position' : OX.annotate.moveLabel(ply, node.san);
        };
        const left = s.total - s.done;
        const now = {
          running: s.current ? [`Now: after `, chip(label(s.current.ply), s.current.ply, 'Go to this move'),
            `, depth ${s.current.depth} (${s.current.seconds} s). At most ${minutes(left * s.target.seconds)} left.`]
            : ['Working…'],
          waiting: ['Waiting while your engine bar searches.'],
          queued: ['Waiting: a chapter opened after this one goes first.'],
          paused: ['Paused.'],
          done: [`Every position analysed (${rule}).`],
          no_engine: ['Stockfish is not installed on this Mac.'],
        }[s.state] || [];
        return [
          OX.el('div', { class: 'head' },
            OX.el('span', { class: 'title grow', text: `Deep analysis: ${s.done} of ${s.total} positions` }),
            s.state === 'done' || s.state === 'no_engine' ? null : OX.el('button', {
              type: 'button', class: 'link', title: paused ? 'Go on analysing this chapter' : `Stop analysing this chapter (${rule})`,
              onclick: () => togglePause(data.chapterId, paused), text: paused ? 'Resume' : 'Pause',
            })),
          OX.el('div', { class: 'dim small row' }, ...now),
        ];
      }

      function render(force = false) {
        if (!alive) return;
        const data = OX.lichess.annotationData();
        if (!data || data.nodes.length < 2) {
          root.style.display = 'none';
          shown = '';
          return;
        }
        // Another chapter: what was said about the last one's publish goes.
        if (note && note.chapterId !== data.chapterId) note = null;
        const full = merged(data);
        const state = OX.annotate.status(full);
        const key = JSON.stringify([state, busy, note, offline, deep && deep.chapterId === data.chapterId ? deep.status : null,
          data.canContribute]);
        if (!force && key === shown) return;
        shown = key;
        root.style.display = '';
        const lines = deepLines(data);
        if (data.canContribute) {
          const button = OX.el('button', {
            class: 'btn primary', disabled: !state.ready || busy,
            title: state.ready ? 'Publish your analysis to this chapter now; Lichess then marks the mistakes'
              : 'Every move needs a result first: the deep analysis publishes by itself when it has them all',
            onclick: () => { const now = OX.lichess.annotationData(); annotate(now ? merged(now) : full); },
            text: state.annotated ? 'Annotate again' : 'Annotate chapter',
          });
          const missing = state.missing.slice(0, SHOW_MISSING)
            .map(m => (m.depth == null ? chip(m.label, m.ply, 'Go to this move: the engine analyses it')
              : chip(`${m.label} (depth ${m.depth})`, m.ply,
                `Only depth ${m.depth} so far (a search stopped at once): go to this move and let the engine reach depth ${OX.annotate.MIN_DEPTH}`)));
          const more = state.missing.length - missing.length;
          lines.push(
            OX.el('div', { class: 'head' },
              OX.el('span', { class: 'title grow', text: `Your analysis: ${state.analysed} of ${state.total} moves` }),
              button),
            state.missing.length ? OX.el('div', { class: 'dim small row' }, 'Not analysed yet: ',
              ...missing.flatMap((c, i) => (i ? [', ', c] : [c])), more > 0 ? ` and ${more} more` : '') : null,
            state.shallowest ? OX.el('div', { class: 'dim small row' }, 'Shallowest: ',
              chip(state.shallowest.label, state.shallowest.ply, 'Go to this move to analyse it deeper (+)'),
              ` at depth ${state.shallowest.depth}`) : null,
            note ? OX.el('div', { class: `${note.cls} small row`, role: 'status', text: note.text }) : null);
        }
        root.replaceChildren(...lines.filter(Boolean)); // replaceChildren() would print a null as "null"
      }

      // Hidden tabs go on asking (slowed by Chrome), so the analysis goes on
      // while you look at another tab; only the drawing waits.
      const tick = () => {
        if (!alive) return;
        analyse();
        if (!document.hidden) render();
        timer = setTimeout(tick, POLL_MS);
      };
      tick();

      return {
        update() { render(); },
        destroy() {
          alive = false;
          clearTimeout(timer);
        },
      };
    },
  });
})();
