// Your repertoire, in the left column, and everything you do with it, so the
// app itself is not needed: what you prepared from the position on the board
// (per colour, main line first), the rest of your main line, the named lines
// passing through here with edit / main-or-sideline / delete / play-the-rest,
// managing all saved lines, extending a line you've played past, and saving
// a new one. A warning says where the line on the board left your repertoire.
// Moves play on Lichess's board. Talks to the app's repertoire API.
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
  function invalidate() {
    cache.index = null;
    cache.loading = null;
  }
  OX.bridge.onRepertoireChanged?.(() => {
    invalidate();
    OX.emit('repertoireChanged');
  });
  const label = color => (color === 'white' ? 'White' : 'Black');
  const LABELS = { main: 'Main', sideline: 'Side', alternative: 'Alt', trap: 'Trap' };
  const LINE_KINDS = { main: 'Main line', sideline: 'Sideline', alternative: 'Alternative', trap: 'Trap' };
  const snapshot = branch => ({ name: branch.name || '', label: branch.label, moves_san: branch.moves_san });
  // The side at the bottom of the board: the one you are looking from.
  const boardSide = () =>
    (document.querySelector('main.analyse .cg-wrap')?.classList.contains('orientation-black') ? 'black' : 'white');

  OX.loadRepertoire = async () => {
    if (cache.index && Date.now() - cache.at < 60_000) return cache.index;
    if (!cache.loading) {
      const request = Promise.all(COLORS.map(color => OX.bridge.api('GET', `/repertoire/tree?color=${color}`)))
        .then(trees => {
          if (cache.loading !== request) return OX.loadRepertoire();
          cache.index = R.buildIndex(trees);
          cache.at = Date.now();
          return cache.index;
        })
        .finally(() => { if (cache.loading === request) cache.loading = null; });
      cache.loading = request;
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
      let movePath = null;
      let token = 0;
      let alive = true;
      let managing = false;
      let lineFilter = '';
      let editor = null;
      let deleting = null;  // branch as it was when confirmation opened
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

      // One change at a time: a second click on Delete (the row is still
      // there until the app has answered) asked for the same line again and
      // said "That didn't work" about a delete that did.
      let busy = false;
      async function act(work, done) {
        if (busy) return;
        busy = true;
        try {
          await work();
          if (done) say(done);
        } catch (error) {
          say(error.offline ? OX.offlineText() : error.status === 409
            ? 'This line changed in another tab. Review the current line and try again.'
            : error.status === 400 && error.detail || "That didn't work.");
        }
        invalidate();
        try { if (alive) await refresh(); } finally { busy = false; }
      }

      // The moves on the board from the normal start, replayed: null when the
      // board doesn't start there (a set-up position: its moves lead elsewhere
      // from the normal start), or while Lichess's move list and its FEN box
      // disagree for a moment (drawn again shortly).
      function boardPath(key = position.key) {
        const line = OX.movesOnBoard();
        if (!line) return null;
        const id = line.join(' ');
        if (pathCache.id !== id) pathCache = { id, path: R.replay(line) };
        const path = pathCache.path;
        if (!path) return null;
        if (path.keys[path.keys.length - 1] !== key) {
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
            // "Main line" only when every move on it is one: a line made of
            // sidelines (nothing marked main from here) says so.
            OX.el('span', { class: 'dim', text: `${line.every(m => m.main) ? 'Main line' : 'Your line'}: ${OX.numberMoves(position.fen, line.map(m => m.san))}` }),
            OX.el('button', {
              class: 'link small', title: `Play these ${line.length} moves on the board`,
              onclick: () => OX.lichess.playUciList(line.map(m => m.uci)),
            }, 'Play it')) : null);
      }

      function lineRow({ branch, at, difference, here }) {
        const rest = here ? branch.ucis.slice(at) : [];
        if (deleting?.id === branch.id) {
          const expected = snapshot(deleting);
          const cancel = () => {
            deleting = null;
            render();
            body.querySelector(`[data-delete-line="${branch.id}"]`)?.focus();
            refresh();
          };
          const target = deleting.name ? `“${deleting.name}”` : 'this line';
          return OX.el('div', { class: 'linerow confirm' },
            OX.el('div', {},
              OX.el('div', { text: `Delete ${target} from your ${label(deleting.color)} repertoire?` }),
              OX.el('div', { class: 'dim small', text: OX.numberMoves(START, deleting.sans) })),
            OX.el('div', { class: 'btns' },
              OX.el('button', { class: 'btn danger', text: 'Delete', onclick: () => {
                if (busy) return;
                deleting = null;
                body.querySelector('.line-search, .saved-lines-heading')?.focus({ preventScroll: true });
                act(() => OX.bridge.api('DELETE', `/repertoire/tree/branches/${branch.id}`, expected), 'Line deleted.');
              } }),
              OX.el('button', { class: 'btn cancel-delete', text: 'Cancel', onclick: cancel })));
        }
        const main = branch.label === 'main';
        const transposed = difference >= 0;
        const ends = at === branch.sans.length;
        const detail = [transposed ? 'Other move order' : '', ends && here ? 'Ends here' : '', branch.name]
          .filter(Boolean).join(' · ');
        const fullMoves = R.numberFrom(0, branch.sans);
        // For long lines, show the moves around the position being compared.
        // For another move order, show where it first differs from the board.
        const moves = R.excerpt(branch.sans, transposed ? Math.min(difference, branch.sans.length) : at ?? 0);
        const edit = icon('pencil', 'Edit this line', () => openEditor(branch), 'line-button');
        edit.setAttribute('data-edit-line', branch.id);
        edit.append('Edit');
        const remove = icon('trash', 'Delete this line', () => {
          deleting = branch;
          render();
          body.querySelector('.cancel-delete')?.focus();
        }, 'danger line-button');
        remove.setAttribute('data-delete-line', branch.id);
        remove.append('Delete');
        return OX.el('div', { class: 'linerow saved-line' },
          OX.el('div', { class: 'line-identity' },
            OX.el('span', { class: `dot ${branch.color}`, title: label(branch.color), role: 'img', 'aria-label': label(branch.color) }),
            OX.el('span', { class: 'line-moves', title: fullMoves, text: moves }),
            edit),
          OX.el('div', { class: 'line-meta' },
            OX.el('span', { class: `pill ${branch.label}`, text: LABELS[branch.label] || branch.label }),
            OX.el('span', { class: 'grow dim ellipsis small', title: detail, text: detail }),
            OX.el('span', { class: 'actions' },
              rest.length ? icon('play', `Play the rest of this line on the board (${rest.length} move${rest.length === 1 ? '' : 's'})`, () => OX.lichess.playUciList(rest)) : null,
              icon(main ? 'star' : 'starOutline', main ? 'Make it a sideline' : 'Make it a main line',
                () => act(() => OX.bridge.api('PATCH', `/repertoire/tree/branches/${branch.id}`, { label: main ? 'sideline' : 'main', expected: snapshot(branch) }),
                  main ? 'Now a sideline.' : 'Now a main line.'), main ? 'on' : '')),
            remove));
      }

      function linesSection(path) {
        const matchesOnBoard = index.through.get(position.key);
        let ply = path?.sans.length;
        let matches = matchesOnBoard;
        // If the board has gone off book, show the last prepared position in
        // the played line. The starting position would match every opening.
        if (!matches && !managing && path) {
          for (ply--; ply > 0; ply--) {
            matches = index.through.get(path.keys[ply]);
            if (matches) break;
          }
        }
        const prefix = path?.sans.slice(0, ply);
        const matching = (matches || []).map(({ branch, at }) => {
          // The index stores the first visit to a position. Prefer the actual
          // move sequence on the board if the position occurs again later.
          const difference = prefix?.findIndex((san, i) => san !== branch.sans[i]);
          if (difference === -1) at = ply;
          const ends = at === branch.sans.length;
          const rank = (difference >= 0 ? 2 : 0) + (ends ? 0 : 1);
          return { branch, at, difference, here: !!matchesOnBoard, rank };
        });
        const list = [...matching];
        if (managing) {
          const ids = new Set(matching.map(({ branch }) => branch.id));
          for (const branch of index.branches) if (!ids.has(branch.id)) list.push({ branch, rank: 4 });
        }
        list.sort((a, b) => a.rank - b.rank || Number(b.branch.color === side) - Number(a.branch.color === side)
          || Number(b.branch.label === 'main') - Number(a.branch.label === 'main') || a.branch.sans.length - b.branch.sans.length);
        if (!list.length) return null;
        const rows = list.map(item => {
          const { branch } = item;
          return {
            node: lineRow(item),
            // What the filter looks through: the line itself, not what its row
            // happens to show.
            terms: [branch.name, LINE_KINDS[branch.label], label(branch.color), R.numberFrom(0, branch.sans), branch.sans.join(' ')]
              .filter(Boolean).map(text => text.toLowerCase()),
            keep: deleting?.id === branch.id,
          };
        });
        const countLabel = OX.el('span', { class: 'dim line-matches' });
        const applyFilter = () => {
          const wanted = lineFilter.trim().toLowerCase();
          let count = 0;
          for (const row of rows) {
            row.node.hidden = !(row.keep || row.terms.some(text => text.includes(wanted)));
            if (!row.node.hidden) count++;
          }
          countLabel.textContent = `${count} of ${list.length}`;
        };
        const search = managing ? OX.el('input', {
          class: 'line-search', type: 'search', placeholder: 'Search moves or opening names',
          'aria-label': 'Find a repertoire line', value: lineFilter,
          oninput: event => { lineFilter = event.target.value; applyFilter(); },
        }) : null;
        if (managing) applyFilter();
        const heading = !managing && (matchesOnBoard ? 'Saved lines at this position' : `Saved lines before ${R.numberFrom(ply, [path.sans[ply]])}`);
        return OX.el('div', { class: 'section' },
          managing ? OX.el('div', { class: 'line-search-row' }, search, countLabel)
            : OX.el('div', { class: 'section-title saved-lines-heading', role: 'heading', 'aria-level': 3, tabindex: -1, text: heading }),
          OX.el('div', { class: 'lines list' }, rows.map(row => row.node)));
      }

      function manageLines() {
        if (!managing && (!index.branches.length || form)) return null;
        return OX.el('div', { class: 'section manage-lines' },
          OX.el('button', {
            class: 'link manage-toggle', text: managing ? 'Back to board position' : 'Manage saved lines',
            onclick: () => {
              managing = !managing;
              lineFilter = '';
              deleting = null;
              render();
              (body.querySelector(managing ? '.line-search' : '.manage-toggle')
                || body.querySelector(managing ? '.manage-toggle' : '.ox-open-save'))?.focus();
            },
          }));
      }

      function statusMessage() {
        return notice && Date.now() < notice.until ? OX.el('div', { class: 'ok', role: 'status', text: notice.text }) : null;
      }

      function openEditor(branch) {
        if (busy) return;
        const expected = snapshot(branch);
        const listTop = body.querySelector('.lines')?.scrollTop || 0;
        const boxTop = root.scrollTop;
        let moves = branch.sans;
        let pending = false;
        let stale = false;
        const heading = OX.el('div', { class: 'section-title', role: 'heading', 'aria-level': 3, tabindex: -1,
          text: `Edit ${label(branch.color)} line` });
        const name = OX.el('input', { type: 'text', value: expected.name, maxlength: 120, placeholder: 'Opening name' });
        const kind = OX.el('select', {},
          Object.entries(LINE_KINDS).map(([value, text]) => OX.el('option', { value, text })));
        kind.value = expected.label;
        const status = OX.el('div', { class: 'small', role: 'status' });
        const submit = OX.el('button', { class: 'btn primary', type: 'submit', text: 'Save changes' });
        const proposed = OX.el('div', { class: 'edit-preview', hidden: true });
        const proposedMoves = OX.el('div', { class: 'moves' });
        proposed.append(OX.el('div', { class: 'small', text: 'New moves' }), proposedMoves);

        const changes = () => {
          const patch = {};
          if (moves.join(' ') !== branch.sans.join(' ')) patch.moves_san = moves.join(' ');
          if (name.value.trim() !== expected.name) patch.name = name.value.trim();
          if (kind.value !== expected.label) patch.label = kind.value;
          return patch;
        };
        const restoreList = () => {
          const list = body.querySelector('.lines');
          if (list) list.scrollTop = listTop;
          root.scrollTop = boxTop;
          const button = body.querySelector(`[data-edit-line="${branch.id}"]`);
          const target = button && !button.closest('[hidden]') ? button : body.querySelector('.manage-toggle');
          target?.focus({ preventScroll: true });
        };
        const cancel = OX.el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: async () => {
          editor = null;
          if (!stale) { render(); restoreList(); }
          await refresh();
          if (stale && alive) restoreList();
        } });
        const useBoard = OX.el('button', { class: 'btn', type: 'button', text: 'Use board moves', onclick: () => {
          const current = OX.readPosition();
          const path = current && boardPath(current.key);
          if (!path?.sans.length) {
            status.textContent = 'Play a line from the starting position first.';
            return;
          }
          moves = path.sans;
          proposed.hidden = !changes().moves_san;
          proposedMoves.textContent = R.numberFrom(0, moves);
          status.textContent = proposed.hidden ? 'The board already matches the saved moves.' : '';
          update(path);
        } });
        const playSaved = OX.el('button', { class: 'btn', type: 'button', text: 'Play saved line', onclick: () => {
          if (OX.movesOnBoard() === null || !OX.lichess.toStart() || !OX.lichess.playUciList(branch.ucis)) {
            status.textContent = 'Could not play the saved line on this board.';
          }
        } });
        const update = (path = boardPath()) => {
          useBoard.disabled = pending || stale || !path?.sans.length;
          playSaved.disabled = pending || stale || !path;
          submit.disabled = pending || stale || !Object.keys(changes()).length;
          name.disabled = kind.disabled = cancel.disabled = pending;
        };
        const save = async event => {
          event.preventDefault();
          if (submit.disabled) return;
          const patch = changes();
          pending = true;
          status.textContent = 'Saving…';
          update();
          try {
            await OX.bridge.api('PATCH', `/repertoire/tree/branches/${branch.id}`, { ...patch, expected });
          } catch (error) {
            if (!alive) return;
            pending = false;
            stale = error.status === 409 || error.status === 404;
            if (stale) invalidate();
            status.textContent = stale ? 'This line changed while you were editing. Cancel and reopen it to see the latest version.'
              : error.offline ? OX.offlineText() : error.detail || 'Could not save the changes.';
            update();
            return;
          }
          invalidate();
          if (!alive) return;
          say('Line updated.');
          editor = null;
          await refresh();
          if (alive) restoreList();
        };
        const draft = OX.el('form', { class: 'saveform line-editor', onsubmit: save, oninput: () => update() },
          heading,
          OX.el('div', { class: 'edit-preview' },
            OX.el('div', { class: 'small', text: 'Saved moves' }),
            OX.el('div', { class: 'moves', text: R.numberFrom(0, branch.sans) })),
          OX.el('div', { class: 'btns' }, playSaved, useBoard),
          OX.el('div', { class: 'dim small', text: 'Play your new move order on the board, then choose Use board moves.' }),
          proposed,
          OX.el('label', {}, 'Name', name),
          OX.el('label', {}, 'Line type', kind),
          OX.el('div', { class: 'btns' }, submit, cancel), status);
        draft.addEventListener('keydown', event => {
          if (event.key !== 'Escape' || event.target === kind || pending) return;
          event.stopPropagation();
          cancel.click();
        });
        deleting = null;
        editor = { update };
        body.replaceChildren(draft);
        root.scrollTop = 0;
        update();
        heading.focus();
      }

      function footer(path) {
        // Only a line that really leads from the normal start to this position.
        const line = path?.sans;
        if (form) return form;
        const buttons = [];
        if (line?.length) {
          // A saved line you have played past (by its own moves, or by another
          // move order that reaches its last position): offer to extend it.
          for (const { branch, moves, transposed } of (path ? R.extensions(index, path) : []).slice(0, 2)) {
            const name = nameOf(branch);
            // The dot says whose line it is: lines of both colours can be
            // offered here, often with the same opening name.
            const whose = `your ${label(branch.color)} line`;
            buttons.push(OX.el('button', {
              class: 'btn',
              title: transposed
                ? `Add the moves from here on to ${whose} “${name}”. It reaches this position by another move order and keeps its own moves.`
                : `Make ${whose} “${name}” continue to this move`,
              onclick: () => act(() => OX.bridge.api('PATCH', `/repertoire/tree/branches/${branch.id}`, {
                moves_san: moves.join(' '), expected_moves_san: branch.sans.join(' '),
              }), `Extended “${name}”.`),
            }, OX.el('span', { class: `dot ${branch.color}` }), `Extend “${name.length > 22 ? `${name.slice(0, 21)}…` : name}”`));
          }
          buttons.unshift(OX.el('button', { class: 'btn primary ox-open-save', onclick: () => openForm(line, path) }, svgEl('plus'), 'Save this line'));
        }
        const message = statusMessage();
        if (!message && !buttons.length) return null;
        return OX.el('div', { class: 'footer' }, message, buttons.length ? OX.el('div', { class: 'btns' }, buttons) : null);
      }

      async function openForm(line, path) {
        let color = boardSide();
        let baseline = index;
        const moves = line.join(' ');
        const savedLine = () => baseline.branches.find(b => b.color === color && b.sans.join(' ') === moves);
        const name = OX.el('input', { type: 'text', placeholder: "Name (empty: the opening's name)", maxlength: 120, 'aria-label': 'Name of the line' });
        const kind = OX.el('select', { 'aria-label': 'Kind of line' },
          Object.entries(LINE_KINDS).map(([value, text]) => OX.el('option', { value, text })));
        const sides = OX.el('div', { class: 'seg' });
        // What is already saved for this exact line, or for its last position
        // by another move order.
        const known = OX.el('div', { class: 'dim small' });
        // The name and kind follow what is known (the saved line's own, else
        // the opening's name) until you change them yourself: saving a line
        // again without touching them must not rename it.
        let suggested = '';
        let named = false;
        let kindChosen = false;
        name.addEventListener('input', () => { named = true; });
        kind.addEventListener('change', () => { kindChosen = true; });
        const drawKnown = () => {
          const same = savedLine();
          if (!named) name.value = same ? same.name || '' : suggested;
          if (!kindChosen) kind.value = same?.label || 'main';
          const others = path ? (baseline.through.get(path.keys[path.keys.length - 1]) || [])
            .filter(({ branch, at }) => branch.color === color && branch !== same && R.otherOrder(branch, at, path)) : [];
          if (same) known.textContent = `Already saved as “${nameOf(same)}”. Saving again changes its name and kind.`;
          else if (others.length) {
            known.textContent = `This position is already in “${nameOf(others[0].branch)}”${others.length > 1 ? ` and ${others.length - 1} more` : ''} by another move order, so what you prepared from here already shows. Save this only to keep this move order as a line too.`;
          } else known.textContent = '';
          known.hidden = !known.textContent;
        };
        const sideButtons = COLORS.map(c => OX.el('button', {
          type: 'button', onclick: () => { color = c; drawSides(); },
        }, OX.el('span', { class: `dot ${c}` }), `As ${label(c)}`));
        sides.append(...sideButtons);
        const drawSides = () => {
          sideButtons.forEach((button, i) => {
            const active = COLORS[i] === color;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
          });
          drawKnown();
        };
        drawSides();
        const status = OX.el('span', { class: 'dim', role: 'status' });
        const submit = OX.el('button', { class: 'btn primary', text: 'Save' });
        const save = async () => {
          if (submit.disabled || form !== draft) return;
          submit.disabled = true;
          const savedColor = color;
          const same = savedLine();
          const expected = same ? { id: same.id, name: same.name || '', label: same.label } : 'new';
          status.textContent = 'Saving…';
          try {
            await OX.bridge.api('POST', '/repertoire/tree/branches', { color: savedColor, name: name.value.trim(), moves_san: moves, label: kind.value, expected });
          } catch (error) {
            if (error.status === 409) {
              invalidate();
              const updated = await refresh();
              if (updated && form === draft) {
                baseline = updated;
                drawKnown();
              }
              status.textContent = updated
                ? 'This line changed in another tab. Review it before saving again.'
                : 'This line changed. Try again to load its latest details.';
            } else status.textContent = error.offline ? OX.offlineText()
              : error.status === 400 && error.detail || "Couldn't save it.";
            submit.disabled = false;
            return;
          }
          invalidate();
          if (!alive) return;
          if (form === draft) form = null;
          say(`Saved to your ${label(savedColor)} repertoire.`);
          await refresh();
        };
        const close = () => {
          form = null;
          render();
          refresh();
          body.querySelector('.ox-open-save')?.focus();
        };
        submit.addEventListener('click', save);
        name.addEventListener('keydown', event => { if (event.key === 'Enter') save(); });
        const draft = OX.el('div', { class: 'saveform' },
          OX.el('div', { class: 'section-title', text: 'Save this line' }),
          OX.el('div', { class: 'dim moves', text: OX.numberMoves(START, line) }),
          sides, known, name, kind,
          OX.el('div', { class: 'btns' },
            submit,
            OX.el('button', { class: 'btn', onclick: close, text: 'Cancel' }),
            status));
        draft.addEventListener('keydown', event => {
          if (event.key !== 'Escape' || event.target === kind) return;
          event.stopPropagation();
          close();
        });
        form = draft;
        lineFilter = '';
        deleting = null;
        render();
        form.scrollIntoView({ block: 'nearest' });
        name.focus();
        try {
          const found = await OX.bridge.api('GET', `/openings/classify?moves_san=${encodeURIComponent(line.join(' '))}`);
          if (found?.name) {
            suggested = found.name;
            drawKnown();
            // The suggestion arrives a moment after the cursor is in the box:
            // select it, so typing a name of your own replaces it instead of
            // being added to its end.
            if (!named && form === draft && root.getRootNode().activeElement === name) name.select();
          }
        } catch { /* type a name */ }
      }

      function render() {
        if (!index || !position) return;
        if (editor) { editor.update(); return; }
        const entry = index.positions.get(position.key);
        const path = boardPath();
        const left = path ? R.leftAt(index, path, side) : null;
        const sections = COLORS.map(color => sideSection(entry, color)).filter(Boolean);
        const ended = COLORS.filter(c => entry?.reached[c]);
        const names = lines => (lines.length ? `: ${lines.map(nameOf).join(', ')}` : '');
        // Played past the end of a line of either colour (the warning above
        // is only about the side at the bottom of the board).
        const past = left?.past ? left : path ? COLORS.map(c => R.leftAt(index, path, c)).find(l => l?.past) : null;
        const status = sections.length
          ? null
          : OX.el('div', { class: 'section dim' },
            ended.length ? `End of your prepared line${names(entry.ends)}.`
              : past ? `Past the end of your prepared line${names(past.ends)}.`
                : 'Not in your repertoire.');
        // Drawing again must not move what you were looking at: the list of
        // lines and the box itself keep their scroll positions.
        const listTop = body.querySelector('.lines')?.scrollTop || 0;
        const boxTop = root.scrollTop;
        const active = root.getRootNode().activeElement;
        const deleteLine = active?.getAttribute('data-delete-line');
        const editLine = active?.getAttribute('data-edit-line');
        const focusSelector = deleteLine ? `[data-delete-line="${deleteLine}"]`
          : editLine ? `[data-edit-line="${editLine}"]`
          : ['.ox-open-save', '.manage-toggle', '.line-search', '.cancel-delete', '.saved-lines-heading']
            .find(selector => active?.matches(selector));
        const cursor = focusSelector && active.matches('input')
          ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
        const lines = form ? null : linesSection(path);
        const boardSections = [...leftBanner(left), ...sections, status];
        const startingPosition = position.key === OX.positionKey(START);
        const content = managing ? [manageLines(), lines || OX.el('div', { class: 'section dim', text: 'No saved lines.' }), statusMessage()]
          : [manageLines(), ...(startingPosition ? [...boardSections, lines] : [lines, ...boardSections]), footer(path)];
        body.replaceChildren(...content.filter(Boolean));
        const list = body.querySelector('.lines');
        if (list) list.scrollTop = listTop;
        root.scrollTop = boxTop;
        const replacement = focusSelector && (body.querySelector(focusSelector) || (managing && body.querySelector('.manage-toggle')));
        if (replacement) {
          replacement.focus({ preventScroll: true });
          if (cursor && replacement.matches('input')) replacement.setSelectionRange(...cursor);
        }
      }

      async function refresh() {
        const mine = ++token;
        try {
          const loaded = await OX.loadRepertoire();
          if (mine !== token) return;
          index = loaded;
          if (!form) render();
          return loaded;
        } catch (error) {
          if (mine === token && !form && !editor) body.replaceChildren(OX.el('div', { class: 'offline', text: error.offline ? OX.offlineText() : "Couldn't load your repertoire." }));
        }
      }

      const stopListening = OX.on('repertoireChanged', () => {
        if (!form && !editor && !deleting) refresh();
      });

      return {
        async update(next) {
          const nextPath = OX.$(OX.anchors.activeMove.selector)?.getAttribute('p') || '';
          if (position && (next.fen !== position.fen || nextPath !== movePath)) {
            if (!managing && !editor) {
              deleting = null;
              form = null;
              root.scrollTop = 0;
            }
            if (!managing || !lineFilter) {
              const list = body.querySelector('.lines');
              if (list) list.scrollTop = 0;
            }
            pathRetries = 0;
          }
          position = next;
          movePath = nextPath;
          await refresh();
        },
        // Flipping the board changes whose repertoire the warning is about.
        tick() {
          const now = boardSide();
          if (now !== side) { side = now; if (!form) render(); }
        },
        destroy() { alive = false; token++; stopListening(); },
      };
    },
  });
})();
