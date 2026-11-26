// Annotate chapter: in a study chapter of yours, under the move list. You step
// through the moves with your Stockfish (and "+" where you want it deeper);
// this shows how many moves have a result, which don't yet, and the
// shallowest one. Once every move has one, a press publishes them to the
// chapter (Lichess's own Publish, as after "Analyse on your device"), and
// Lichess marks the moves itself: ?!, ?, ??, "X was best", the accuracy
// chart. Pressing it again after going deeper updates the marks.
//
// The logic is src/annotate-core.js; the page side is page-bridge.js.
(() => {
  const OX = globalThis.OX;
  const POLL_MS = 1500;
  const SHOW_MISSING = 6;

  const refusal = ({ status, message }) => {
    if (status === 423) return "Lichess's own server analysis of this chapter is still running. Try again when it is done.";
    if (status === 401 || status === 403) return 'Only members of the study who can change it can annotate it.';
    if (status === 404) return 'Lichess no longer has this chapter.';
    if (!status) return `Couldn't reach Lichess (${message || 'no answer'}).`;
    return `Lichess refused it (${status}${message ? `: ${message.slice(0, 120)}` : ''}).`;
  };

  OX.defineFeature({
    id: 'annotate',
    name: 'Annotate chapter',
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
      let busy = false;
      let note = null;     // { text, cls } after a publish

      const jump = ply => () => OX.lichess.jumpToPly(ply);
      const chip = (label, ply, title) => OX.el('button', { type: 'button', class: 'link', title, onclick: jump(ply), text: label });

      async function annotate(data) {
        busy = true;
        note = { text: 'Publishing your analysis…', cls: 'dim' };
        render(true);
        let answer;
        try {
          answer = await OX.lichess.publishAnalysis(OX.annotate.build(data));
        } catch (error) {
          answer = { status: 0, message: error.message };
        }
        busy = false;
        note = answer.status >= 200 && answer.status < 300
          ? { text: 'Annotated. Lichess is adding its marks to the moves.', cls: 'ok' }
          : { text: refusal(answer), cls: 'bad' };
        render(true);
      }

      function render(force = false) {
        if (!alive) return;
        const data = OX.lichess.annotationData();
        if (!data || !data.canContribute || data.nodes.length < 2) {
          root.style.display = 'none';
          shown = '';
          return;
        }
        const state = OX.annotate.status(data);
        const key = JSON.stringify([state, busy, note]);
        if (!force && key === shown) return;
        shown = key;
        root.style.display = '';
        const button = OX.el('button', {
          class: 'btn primary', disabled: !state.ready || busy,
          title: state.ready ? 'Publish your analysis to this chapter; Lichess then marks the mistakes'
            : `Every move needs a result of depth ${OX.annotate.MIN_DEPTH} or more first: step through the moves with the engine on`,
          onclick: () => annotate(OX.lichess.annotationData() || data),
          text: state.annotated ? 'Annotate again' : 'Annotate chapter',
        });
        const missing = state.missing.slice(0, SHOW_MISSING)
          .map(m => (m.depth == null ? chip(m.label, m.ply, 'Go to this move: the engine analyses it')
            : chip(`${m.label} (depth ${m.depth})`, m.ply,
              `Only depth ${m.depth} so far (a search stopped at once): go to this move and let the engine reach depth ${OX.annotate.MIN_DEPTH}`)));
        const more = state.missing.length - missing.length;
        root.replaceChildren(...[
          OX.el('div', { class: 'head' },
            OX.el('span', { class: 'title grow', text: `Your analysis: ${state.analysed} of ${state.total} moves` }),
            button),
          state.missing.length ? OX.el('div', { class: 'dim small row' }, 'Not analysed yet: ',
            ...missing.flatMap((c, i) => (i ? [', ', c] : [c])), more > 0 ? ` and ${more} more` : '') : null,
          state.shallowest ? OX.el('div', { class: 'dim small row' }, 'Shallowest: ',
            chip(state.shallowest.label, state.shallowest.ply, 'Go to this move to analyse it deeper (+)'),
            ` at depth ${state.shallowest.depth}`) : null,
          note ? OX.el('div', { class: `${note.cls} small row`, role: 'status', text: note.text }) : null,
        ].filter(Boolean)); // replaceChildren() would print a null as "null"
      }

      const tick = () => {
        if (!alive) return;
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
