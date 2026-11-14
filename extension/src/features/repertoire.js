// Your repertoire, in the left column, and everything you do with it, so the
// app itself is not needed: what you prepared from the position on the board
// (per colour, main line first), the rest of your main line, the named lines
// passing through here with rename / main-or-sideline / delete / play-the-rest,
// extending a line you've played past, and saving a new one. A warning says
// where the line on the board left your repertoire. Moves play on Lichess's
// board. Talks to the app's repertoire API.
//
// Everything is looked up by POSITION (src/repertoire-index.js), so a
// position reached by another move order shows what you prepared for it.
(() => {
  const OX = globalThis.OX;
  const COLORS = ['white', 'black'];
  const R = OX.rep;
  const START = R.START;
  // Icons as SVG: Lichess's icon font doesn't reach inside shadow roots.
  const SVG = {
    // Two arrows: "play these moves out", not a triangle that looks like "open this".
    play: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M3 5v14l9-7zM12 5v14l9-7z"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
    star: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
    starOutline: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14m-7-7h14"/></svg>',
    caution: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
  };
  const svgEl = name => {
    const span = document.createElement('span');
    span.className = 'ox-svg-icon';
    span.innerHTML = SVG[name] || '';
    return span;
  };
  const cache = { index: null, at: 0, loading: null };
  const label = color => (color === 'white' ? 'White' : 'Black');
  const LABELS = { main: 'Main', sideline: 'Side', alternative: 'Alt', trap: 'Trap' };
  // The side at the bottom of the board: the one you are looking from.
  const boardSide = () =>
    (document.querySelector('main.analyse .cg-wrap')?.classList.contains('orientation-black') ? 'black' : 'white');

  OX.loadRepertoire = async () => {
    if (cache.index && Date.now() - cache.at < 60_000) return cache.index;
    if (!cache.loading) {
      cache.loading = Promise.all(COLORS.map(color => OX.bridge.api('GET', `/repertoire/tree?color=${color}`)))
        .then(trees => { cache.index = R.buildIndex(trees); cache.at = Date.now(); return cache.index; })
        .finally(() => { cache.loading = null; });
    }
    return cache.loading;
  };

  OX.defineFeature({
    id: 'repertoire',
    name: 'Your repertoire',
    pages: ['analyse'],
    anchors: ['side'],
    needsPosition: true,
    order: 3,
    place: { anchor: 'side', where: 'append', tab: true },

    create(host, root) {
      root.classList.add('card', 'rep');
      let index = null;
      let position = null;
      let token = 0;
      let alive = true;
      let showAllLines = false;
      let lineFilter = '';
      let editing = null;   // branch id being renamed
      let focusEdit = false; // put the cursor in the rename box on the next draw
      let deleting = null;  // branch id waiting for "Delete?" confirmation
      let form = null;      // the Save form, while open
      let notice = null;    // { text, until }
      let side = boardSide();
      let pathCache = { id: null, path: null };
      let pathRetries = 0;

      const body = OX.el('div', {}, OX.el('div', { class: 'dim', text: 'Loading…' }));
      root.append(body);

      const icon = (name, title, onclick, extra = '') => {
        const node = OX.el('button', {
          class: `icon ${extra}`, title, 'aria-label': title,
          onclick: event => { event.stopPropagation(); onclick(); },
        });
        node.innerHTML = SVG[name] || '';
        return node;
      };
      // A short message in the footer, taken away again after 5 s.
      const say = text => {
        notice = { text, until: Date.now() + 5000 };
        setTimeout(() => {
          // Not while you are typing: drawing again would take the cursor away.
          const typing = root.getRootNode().activeElement?.matches?.('input, select');
          if (alive && !typing && notice && Date.now() >= notice.until) { notice = null; render(); }
        }, 5100);
      };
      // A line's name, or its last moves when it has none.
      const nameOf = branch => branch.name || branch.sans.slice(-3).join(' ');

      async function act(work, done) {
        try {
          await work();
          if (done) say(done);
        } catch (error) {
          say(error.offline ? OX.offlineText() : "That didn't work.");
        }
        cache.index = null;
        await refresh();
      }

      // The moves on the board from the normal start, replayed: null when the
      // game doesn't start there, or while Lichess's move list and its FEN box
      // disagree for a moment (drawn again shortly, see render).
      function boardPath() {
        const line = OX.currentLine();
        if (!line) return null;
        const id = line.join(' ');
        if (pathCache.id !== id) pathCache = { id, path: R.replay(line) };
        const path = pathCache.path;
        if (!path) return null;
        if (path.keys[path.keys.length - 1] !== position.key) {
          if (pathRetries++ < 5) setTimeout(() => { if (alive) render(); }, 200);
          return null;
        }
        pathRetries = 0;
        return path;
      }

      // ---- the parts of the box ----
      // Where the line on the board left the repertoire of the side you are
      // looking from. From the whole line, so it shows whether you got here
      // one move at a time, by jumping, or by opening the page here.
      function leftBanner(left) {
        if (!left || left.past) return [];
        const move = R.numberFrom(left.at, [left.san]);
        const yours = left.mover === side;
        return [OX.el('div', { class: 'banner' },
          OX.el('span', { class: 'banner-icon' }, svgEl('caution')),
          OX.el('span', {},
            yours ? `You left your ${label(side)} repertoire with ` : `Out of your ${label(side)} repertoire: you have nothing against `,
            OX.el('b', { text: move }),
            yours ? '. You prepared ' : '. You prepared for ',
            OX.el('b', { text: left.book.map(m => m.san).join(', ') }), '.'))];
      }

      function sideSection(entry, color) {
        const moves = entry ? R.sorted(entry.moves[color]) : [];
        if (!moves.length) return null;
        const toMove = position.fen.split(' ')[1] === 'w' ? 'white' : 'black';
        const yours = color === toMove;
        const line = R.mainLine(index, position.key, color);
        return OX.el('div', { class: 'section' },
          OX.el('div', { class: 'section-head' },
            OX.el('span', { class: `dot ${color}` }),
            OX.el('span', { class: 'section-title', text: label(color) }),
            OX.el('span', { class: 'dim', text: yours ? 'your move' : "you're ready for" })),
          OX.el('div', { class: 'tiles' }, moves.map(move => OX.el('button', {
            class: `tile${move.main ? ' main' : ''}`,
            title: `${move.main ? 'Main line' : 'Sideline'} — play ${move.san}`,
            onclick: () => OX.lichess.playUci(move.uci),
            text: move.san,
          }))),
          line.length > 1 ? OX.el('div', { class: 'mainline' },
            OX.el('span', { class: 'dim', text: `Main line: ${OX.numberMoves(position.fen, line.map(m => m.san))}` }),
            OX.el('button', {
              class: 'link small', title: `Play these ${line.length} moves on the board`,
              onclick: () => OX.lichess.playUciList(line.map(m => m.uci)),
            }, 'Play it')) : null);
      }

      function lineRow({ branch, at }, apart, path) {
        const rest = branch.ucis.slice(at);
        if (editing === branch.id) {
          const input = OX.el('input', { type: 'text', value: branch.name || '', maxlength: 120, 'aria-label': 'Name of the line' });
          const save = () => {
            const name = input.value.trim();
            editing = null;
            act(() => OX.bridge.api('PATCH', `/repertoire/tree/branches/${branch.id}`, { name }), 'Renamed.');
          };
          input.addEventListener('keydown', event => {
            if (event.key === 'Enter') save();
            if (event.key === 'Escape') { editing = null; render(); }
          });
          if (focusEdit) {
            focusEdit = false;
            setTimeout(() => { input.scrollIntoView({ block: 'nearest' }); input.focus(); input.select(); }, 0);
          }
          return OX.el('div', { class: 'linerow editing' }, OX.el('span', { class: `dot ${branch.color}` }), input,
            icon('check', 'Save the name', save, 'good'),
            icon('x', 'Cancel', () => { editing = null; render(); }));
        }
        if (deleting === branch.id) {
          return OX.el('div', { class: 'linerow confirm' },
            OX.el('span', { class: 'grow ellipsis', text: `Delete “${nameOf(branch)}”?` }),
            OX.el('button', { class: 'btn danger', text: 'Delete', onclick: () => { deleting = null; act(() => OX.bridge.api('DELETE', `/repertoire/tree/branches/${branch.id}`), 'Line deleted.'); } }),
            OX.el('button', { class: 'btn', text: 'Cancel', onclick: () => { deleting = null; render(); } }));
        }
        const main = branch.label === 'main';
        const transposed = !!path && R.otherOrder(branch, at, path);
        // Under the name: what tells this line from others of the same name,
        // and whether it gets here by other moves than the board did.
        const detail = [apart, transposed ? 'other move order' : ''].filter(Boolean).join(' · ');
        return OX.el('div', {
          class: 'linerow',
          title: OX.numberMoves(START, branch.sans) + (transposed ? '\n(reaches this position by another move order)' : ''),
        },
          OX.el('span', { class: `dot ${branch.color}`, title: label(branch.color) }),
          OX.el('span', { class: 'linename' },
            OX.el('span', { class: 'nm', text: nameOf(branch) }),
            detail ? OX.el('span', { class: 'apart dim', text: detail }) : null),
          OX.el('span', { class: `pill ${branch.label}`, text: LABELS[branch.label] || branch.label }),
          OX.el('span', { class: 'actions' },
            rest.length ? icon('play', `Play the rest of this line on the board (${rest.length} move${rest.length === 1 ? '' : 's'})`, () => OX.lichess.playUciList(rest)) : null,
            icon('pencil', 'Rename', () => { editing = branch.id; focusEdit = true; deleting = null; render(); }),
            icon(main ? 'star' : 'starOutline', main ? 'Make it a sideline' : 'Make it a main line',
              () => act(() => OX.bridge.api('PATCH', `/repertoire/tree/branches/${branch.id}`, { label: main ? 'sideline' : 'main' }),
                main ? 'Now a sideline.' : 'Now a main line.'), main ? 'on' : ''),
            icon('trash', 'Delete this line', () => { deleting = branch.id; editing = null; render(); }, 'danger')));
      }

      function linesSection(path) {
        const list = [...(index.through.get(position.key) || [])]
          .sort((a, b) => Number(b.branch.label === 'main') - Number(a.branch.label === 'main') || (a.branch.name || '').localeCompare(b.branch.name || ''));
        if (!list.length) return null;
        // Closed until asked for: a position near the start has dozens of lines.
        const apart = showAllLines ? R.tellApart(list.map(item => item.branch)) : new Map();
        const rows = showAllLines ? list.map(item => {
          const { branch } = item;
          return {
            node: lineRow(item, apart.get(branch.id) || '', path),
            // What the filter looks through: the line itself, not what its row
            // happens to show (a row being renamed shows only a text box).
            text: `${nameOf(branch)} ${LABELS[branch.label] || branch.label} ${label(branch.color)} ${OX.numberMoves(START, branch.sans)} ${branch.sans.join(' ')}`.toLowerCase(),
            // The row you are renaming or deleting stays, whatever the filter says.
            keep: editing === branch.id || deleting === branch.id,
          };
        }) : [];
        const matches = OX.el('span', { class: 'dim line-matches' });
        const applyFilter = () => {
          const wanted = lineFilter.trim().toLowerCase();
          let count = 0;
          for (const row of rows) {
            row.node.hidden = !(row.keep || row.text.includes(wanted));
            if (!row.node.hidden) count++;
          }
          matches.textContent = `${count} of ${list.length}`;
        };
        const search = showAllLines ? OX.el('input', {
          class: 'line-search', type: 'search', placeholder: 'Find an opening or move…',
          'aria-label': 'Find a repertoire line', value: lineFilter,
          oninput: event => { lineFilter = event.target.value; applyFilter(); },
        }) : null;
        if (showAllLines) applyFilter();
        return OX.el('div', { class: 'section' },
          OX.el('div', { class: 'section-head', style: 'margin-bottom: 0' },
            OX.el('span', { class: 'section-title', text: 'Lines through here' }),
            OX.el('span', { class: 'dim', text: String(list.length) })),
          showAllLines ? OX.el('div', { class: 'line-search-row' }, search, matches) : null,
          rows.length ? OX.el('div', { class: 'lines list' }, rows.map(row => row.node)) : null,
          OX.el('button', {
            class: 'link small', style: 'margin-top: 6px', onclick: () => { showAllLines = !showAllLines; if (!showAllLines) { lineFilter = ''; editing = deleting = null; } render(); },
            text: showAllLines ? 'Hide lines' : `Browse ${list.length} line${list.length === 1 ? '' : 's'}`,
          }));
      }

      function footer(path) {
        const line = OX.currentLine();
        if (form) return form;
        const buttons = [];
        if (line?.length) {
          // A saved line you have played past (by its own moves, or by another
          // move order that reaches its last position): offer to extend it.
          for (const { branch, moves, transposed } of (path ? R.extensions(index, path) : []).slice(0, 2)) {
            const name = nameOf(branch);
            buttons.push(OX.el('button', {
              class: 'btn',
              title: transposed
                ? `Add the moves from here on to “${name}”. It reaches this position by another move order and keeps its own moves.`
                : `Make “${name}” continue to this move`,
              onclick: () => act(() => OX.bridge.api('PATCH', `/repertoire/tree/branches/${branch.id}`, { moves_san: moves.join(' ') }), `Extended “${name}”.`),
            }, `Extend “${name.length > 22 ? `${name.slice(0, 21)}…` : name}”`));
          }
          buttons.unshift(OX.el('button', { class: 'btn primary', onclick: () => openForm(line, path) }, svgEl('plus'), 'Save this line'));
        }
        const message = notice && Date.now() < notice.until ? OX.el('div', { class: 'ok', text: notice.text }) : null;
        if (!message && !buttons.length) return null;
        return OX.el('div', { class: 'footer' }, message, buttons.length ? OX.el('div', { class: 'btns' }, buttons) : null);
      }

      async function openForm(line, path) {
        let color = boardSide();
        const name = OX.el('input', { type: 'text', placeholder: "Name (empty: the opening's name)", maxlength: 120, 'aria-label': 'Name of the line' });
        const kind = OX.el('select', { 'aria-label': 'Kind of line' },
          OX.el('option', { value: 'main', text: 'Main line' }),
          OX.el('option', { value: 'sideline', text: 'Sideline' }));
        const sides = OX.el('div', { class: 'seg' });
        // What is already saved for this exact line, or for its last position
        // by another move order.
        const known = OX.el('div', { class: 'dim small' });
        const drawKnown = () => {
          const moves = line.join(' ');
          const same = index.branches.find(b => b.color === color && b.sans.join(' ') === moves);
          const others = path ? (index.through.get(path.keys[path.keys.length - 1]) || [])
            .filter(({ branch, at }) => branch.color === color && branch !== same && R.otherOrder(branch, at, path)) : [];
          if (same) known.textContent = `Already saved as “${nameOf(same)}”. Saving again changes its name and kind.`;
          else if (others.length) {
            known.textContent = `This position is already in “${nameOf(others[0].branch)}”${others.length > 1 ? ` and ${others.length - 1} more` : ''} by another move order, so what you prepared from here already shows. Save this only to keep this move order as a line too.`;
          } else known.textContent = '';
          known.hidden = !known.textContent;
        };
        const drawSides = () => {
          sides.replaceChildren(...COLORS.map(c => OX.el('button', {
            class: c === color ? 'active' : '', onclick: () => { color = c; drawSides(); },
          }, OX.el('span', { class: `dot ${c}` }), `As ${label(c)}`)));
          drawKnown();
        };
        drawSides();
        const status = OX.el('span', { class: 'dim' });
        const save = async () => {
          status.textContent = 'Saving…';
          try {
            await OX.bridge.api('POST', '/repertoire/tree/branches', { color, name: name.value.trim(), moves_san: line.join(' '), label: kind.value });
          } catch (error) {
            status.textContent = error.offline ? OX.offlineText() : "Couldn't save it.";
            return;
          }
          form = null;
          say(`Saved to your ${label(color)} repertoire.`);
          cache.index = null;
          refresh();
        };
        name.addEventListener('keydown', event => { if (event.key === 'Enter') save(); });
        form = OX.el('div', { class: 'saveform' },
          OX.el('div', { class: 'section-title', text: 'Save this line' }),
          OX.el('div', { class: 'dim moves', text: OX.numberMoves(START, line) }),
          sides, known, name, kind,
          OX.el('div', { class: 'btns' },
            OX.el('button', { class: 'btn primary', onclick: save, text: 'Save' }),
            OX.el('button', { class: 'btn', onclick: () => { form = null; render(); }, text: 'Cancel' }),
            status));
        // The list of lines would push the form out of sight below it.
        showAllLines = false;
        lineFilter = '';
        editing = deleting = null;
        render();
        form.scrollIntoView({ block: 'nearest' });
        name.focus();
        try {
          const found = await OX.bridge.api('GET', `/openings/classify?moves_san=${encodeURIComponent(line.join(' '))}`);
          if (found?.name && !name.value) name.value = found.name;
        } catch { /* type a name */ }
      }

      function render() {
        if (!index || !position) return;
        const entry = index.positions.get(position.key);
        const path = boardPath();
        const left = path ? R.leftAt(index, path, side) : null;
        const sections = COLORS.map(color => sideSection(entry, color)).filter(Boolean);
        const ended = COLORS.filter(c => entry?.reached[c]);
        const names = lines => (lines.length ? `: ${lines.map(nameOf).join(', ')}` : '');
        const status = sections.length
          ? null
          : OX.el('div', { class: 'section dim' },
            ended.length ? `End of your prepared line${names(entry.ends)}.`
              : left?.past ? `Past the end of your prepared line${names(left.ends)}.`
                : 'Not in your repertoire.');
        // Drawing again must not move what you were looking at: the list of
        // lines and the box itself keep their scroll positions.
        const listTop = body.querySelector('.lines')?.scrollTop || 0;
        const boxTop = root.scrollTop;
        body.replaceChildren(...leftBanner(left), ...sections, ...(status ? [status] : []), ...[linesSection(path), footer(path)].filter(Boolean));
        const list = body.querySelector('.lines');
        if (list) list.scrollTop = listTop;
        root.scrollTop = boxTop;
      }

      async function refresh() {
        const mine = ++token;
        try {
          const loaded = await OX.loadRepertoire();
          if (mine !== token) return;
          index = loaded;
          render();
        } catch (error) {
          if (mine === token) body.replaceChildren(OX.el('div', { class: 'offline', text: error.offline ? OX.offlineText() : "Couldn't load your repertoire." }));
        }
      }

      return {
        async update(next) {
          if (position && next.key !== position.key) {
            editing = deleting = null;
            showAllLines = false;
            lineFilter = '';
            form = null;
            pathRetries = 0;
          }
          position = next;
          await refresh();
        },
        // Flipping the board changes whose repertoire the warning is about.
        tick() {
          const now = boardSide();
          if (now !== side) { side = now; if (!form) render(); }
        },
        destroy() { alive = false; token++; },
      };
    },
  });
})();
