// Your repertoire, in the left column, and everything you do with it, so the
// app itself is not needed: what you prepared from the position on the board
// (per colour, main line first), the rest of your main line, the named lines
// passing through here with rename / main-or-sideline / delete / play-the-rest,
// extending a line you've played past, and saving a new one. A warning shows
// the moment a game or line leaves your repertoire. Moves play on Lichess's
// board. Talks to the app's repertoire API.
(() => {
  const OX = globalThis.OX;
  const COLORS = ['white', 'black'];
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const LINE_PLIES = 10;
  const LINES_SHOWN = 5;
  // Lichess's icon font (lila ui/lib/src/licon.ts).
  const ICON = { pencil: '', trash: '', star: '', starOutline: '', play: '', plus: '', check: '', x: '', caution: '' };
  const cache = { index: null, at: 0, loading: null };
  const label = color => (color === 'white' ? 'White' : 'Black');
  const LABELS = { main: 'Main', sideline: 'Side', alternative: 'Alt', trap: 'Trap' };

  // positions: key -> { moves: {white: Map(san -> move), black}, reached, ends }
  // through:   key -> [{ branch, at }]  (the lines passing through, `at` moves in)
  function buildIndex(trees) {
    const positions = new Map();
    const through = new Map();
    const entry = key => {
      if (!positions.has(key)) {
        positions.set(key, { moves: { white: new Map(), black: new Map() }, reached: { white: false, black: false }, ends: [] });
      }
      return positions.get(key);
    };
    const branches = [];
    for (const tree of trees) {
      const color = tree.color;
      const walk = node => {
        for (const child of node.children || []) {
          const before = entry(OX.positionKey(child.fen_before));
          before.reached[color] = true;
          const known = before.moves[color].get(child.san);
          const main = child.label === 'main';
          if (!known || (main && !known.main)) {
            before.moves[color].set(child.san, { san: child.san, uci: child.uci, main, color, after: OX.positionKey(child.fen_after) });
          }
          entry(OX.positionKey(child.fen_after)).reached[color] = true;
          walk(child);
        }
      };
      walk(tree.root || {});
      for (const raw of tree.branches || []) {
        const chess = new globalThis.OXChess(START);
        const sans = (raw.moves_san || '').split(/\s+/).filter(Boolean);
        const keys = [OX.positionKey(START)];
        const ucis = [];
        try {
          for (const san of sans) {
            const move = chess.move(san);
            ucis.push(move.from + move.to + (move.promotion || ''));
            keys.push(OX.positionKey(chess.fen()));
          }
        } catch { continue; } // a line the app couldn't replay: leave it out here
        const branch = { ...raw, color, sans, ucis, keys };
        branches.push(branch);
        keys.forEach((key, at) => {
          if (!through.has(key)) through.set(key, []);
          through.get(key).push({ branch, at });
        });
        entry(keys[keys.length - 1]).ends.push(branch);
      }
    }
    return { positions, through, branches };
  }

  OX.loadRepertoire = async () => {
    if (cache.index && Date.now() - cache.at < 60_000) return cache.index;
    if (!cache.loading) {
      cache.loading = Promise.all(COLORS.map(color => OX.bridge.api('GET', `/repertoire/tree?color=${color}`)))
        .then(trees => { cache.index = buildIndex(trees); cache.at = Date.now(); return cache.index; })
        .finally(() => { cache.loading = null; });
    }
    return cache.loading;
  };

  const sorted = map => [...map.values()].sort((a, b) => Number(b.main) - Number(a.main));

  function mainLine(index, key, color) {
    const line = [];
    let at = key;
    while (line.length < LINE_PLIES) {
      const next = sorted(index.positions.get(at)?.moves[color] || new Map())[0];
      if (!next) break;
      line.push(next);
      at = next.after;
    }
    return line;
  }

  function oneMoveLater(previous, next) {
    const [, sideA, , , , numA] = previous.split(' ');
    const [, sideB, , , , numB] = next.split(' ');
    if (sideA === sideB) return false;
    const a = parseInt(numA, 10);
    const b = parseInt(numB, 10);
    return sideA === 'w' ? a === b : b === a + 1;
  }

  OX.defineFeature({
    id: 'repertoire',
    name: 'Your repertoire',
    pages: ['analyse'],
    anchors: ['side'],
    needsPosition: true,
    order: 3,
    place: { anchor: 'side', where: 'append' },

    create(host, root) {
      root.classList.add('card', 'rep');
      let index = null;
      let position = null;
      let previous = null; // { position, entry } one move back
      let token = 0;
      let showAllLines = false;
      let editing = null;   // branch id being renamed
      let deleting = null;  // branch id waiting for "Delete?" confirmation
      let form = null;      // the Save form, while open
      let notice = null;    // { text, until }

      const head = OX.el('div', { class: 'head' }, OX.el('span', { class: 'title' }, 'Repertoire'));
      const body = OX.el('div', {}, OX.el('div', { class: 'dim', text: 'Loading…' }));
      root.append(head, body);

      const icon = (glyph, title, onclick, extra = '') => OX.el('button', {
        class: `icon ${extra}`, 'data-icon': glyph, title, 'aria-label': title,
        onclick: event => { event.stopPropagation(); onclick(); },
      });
      const say = text => { notice = { text, until: Date.now() + 5000 }; };

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

      // ---- the parts of the box ----
      function leftBanner(entry) {
        if (!previous?.entry || !oneMoveLater(previous.position.fen, position.fen)) return [];
        return COLORS.flatMap(color => {
          const book = sorted(previous.entry.moves[color]);
          if (!book.length || entry?.reached[color]) return [];
          return [OX.el('div', { class: 'banner' },
            OX.el('span', { class: 'banner-icon', 'data-icon': ICON.caution }),
            OX.el('span', {}, `Out of your ${label(color)} repertoire. You prepared `,
              OX.el('b', { text: book.map(m => m.san).join(', ') }), '.'))];
        });
      }

      function sideSection(entry, color) {
        const moves = entry ? sorted(entry.moves[color]) : [];
        if (!moves.length) return null;
        const toMove = position.fen.split(' ')[1] === 'w' ? 'white' : 'black';
        const yours = color === toMove;
        const line = mainLine(index, position.key, color);
        return OX.el('div', { class: 'section' },
          OX.el('div', { class: 'section-head' },
            OX.el('span', { class: `dot ${color}` }),
            OX.el('span', { class: 'section-title', text: label(color) }),
            OX.el('span', { class: 'dim', text: yours ? 'your move' : "you're ready for" })),
          OX.el('div', { class: 'tiles' }, moves.map(move => OX.el('button', {
            class: `tile${move.main ? ' main' : ''}`,
            title: `${move.main ? 'Main line' : 'Sideline'} — play ${move.san}`,
            onclick: () => OX.lichess.playUci(move.uci),
          }, OX.el('span', { class: 'tile-san', text: move.san }), move.main ? OX.el('span', { class: 'tile-tag', text: 'main' }) : null))),
          line.length > 1 ? OX.el('button', {
            class: 'mainline', title: 'Play your main line from here',
            onclick: () => OX.lichess.playUciList(line.map(m => m.uci)),
          }, OX.el('span', { class: 'play', 'data-icon': ICON.play }), OX.numberMoves(position.fen, line.map(m => m.san))) : null);
      }

      function lineRow({ branch, at }) {
        const rest = branch.ucis.slice(at);
        if (editing === branch.id) {
          const input = OX.el('input', { type: 'text', value: branch.name || '', maxlength: 120 });
          const save = () => act(() => OX.bridge.api('PATCH', `/repertoire/tree/branches/${branch.id}`, { name: input.value.trim() }), 'Renamed.')
            .then(() => { editing = null; render(); });
          input.addEventListener('keydown', event => {
            if (event.key === 'Enter') save();
            if (event.key === 'Escape') { editing = null; render(); }
          });
          setTimeout(() => input.focus(), 0);
          return OX.el('div', { class: 'linerow editing' }, OX.el('span', { class: `dot ${branch.color}` }), input,
            icon(ICON.check, 'Save the name', save, 'good'),
            icon(ICON.x, 'Cancel', () => { editing = null; render(); }));
        }
        if (deleting === branch.id) {
          return OX.el('div', { class: 'linerow confirm' },
            OX.el('span', { class: 'grow', text: `Delete “${branch.name || branch.sans.join(' ')}”?` }),
            OX.el('button', { class: 'btn danger', text: 'Delete', onclick: () => act(() => OX.bridge.api('DELETE', `/repertoire/tree/branches/${branch.id}`), 'Line deleted.').then(() => { deleting = null; render(); }) }),
            OX.el('button', { class: 'btn', text: 'Cancel', onclick: () => { deleting = null; render(); } }));
        }
        const main = branch.label === 'main';
        return OX.el('div', { class: 'linerow', title: OX.numberMoves(START, branch.sans) },
          OX.el('span', { class: `dot ${branch.color}`, title: label(branch.color) }),
          OX.el('span', { class: 'linename', text: branch.name || branch.sans.slice(-3).join(' ') }),
          OX.el('span', { class: `pill ${branch.label}`, text: LABELS[branch.label] || branch.label }),
          OX.el('span', { class: 'actions' },
            rest.length ? icon(ICON.play, `Play the rest of this line (${rest.length} moves)`, () => OX.lichess.playUciList(rest)) : null,
            icon(ICON.pencil, 'Rename', () => { editing = branch.id; deleting = null; render(); }),
            icon(main ? ICON.star : ICON.starOutline, main ? 'Make it a sideline' : 'Make it a main line',
              () => act(() => OX.bridge.api('PATCH', `/repertoire/tree/branches/${branch.id}`, { label: main ? 'sideline' : 'main' }),
                main ? 'Now a sideline.' : 'Now a main line.'), main ? 'on' : ''),
            icon(ICON.trash, 'Delete this line', () => { deleting = branch.id; editing = null; render(); }, 'danger')));
      }

      function linesSection() {
        const list = (index.through.get(position.key) || [])
          .sort((a, b) => Number(b.branch.label === 'main') - Number(a.branch.label === 'main') || (a.branch.name || '').localeCompare(b.branch.name || ''));
        if (!list.length) return null;
        const shown = showAllLines ? list : list.slice(0, LINES_SHOWN);
        return OX.el('div', { class: 'section' },
          OX.el('div', { class: 'section-head' },
            OX.el('span', { class: 'section-title', text: 'Lines through here' }),
            OX.el('span', { class: 'dim', text: String(list.length) })),
          OX.el('div', { class: 'lines' }, shown.map(lineRow)),
          list.length > LINES_SHOWN ? OX.el('button', {
            class: 'more', onclick: () => { showAllLines = !showAllLines; render(); },
            text: showAllLines ? 'Show fewer' : `Show all ${list.length}`,
          }) : null);
      }

      function footer() {
        const line = OX.currentLine();
        if (form) return form;
        const buttons = [];
        if (line?.length) {
          // A saved line you have played past: offer to extend it to here.
          const extendable = index.branches.filter(b => b.sans.length < line.length && b.sans.every((san, i) => san === line[i]))
            .sort((a, b) => b.sans.length - a.sans.length).slice(0, 2);
          for (const branch of extendable) {
            buttons.push(OX.el('button', {
              class: 'btn', title: `Make “${branch.name}” continue to this move`,
              onclick: () => act(() => OX.bridge.api('PATCH', `/repertoire/tree/branches/${branch.id}`, { moves_san: line.join(' ') }), `Extended “${branch.name}”.`),
            }, OX.el('span', { 'data-icon': ICON.plus, class: 'btn-icon' }), `Extend “${branch.name}” to here`));
          }
          buttons.push(OX.el('button', { class: 'btn primary', onclick: () => openForm(line) },
            OX.el('span', { 'data-icon': ICON.plus, class: 'btn-icon' }), 'Save this line'));
        }
        const message = notice && Date.now() < notice.until ? OX.el('div', { class: 'ok', text: notice.text }) : null;
        return OX.el('div', { class: 'footer' }, message, OX.el('div', { class: 'btns' }, buttons));
      }

      async function openForm(line) {
        const black = document.querySelector('main.analyse .cg-wrap')?.classList.contains('orientation-black');
        let color = black ? 'black' : 'white';
        const name = OX.el('input', { type: 'text', placeholder: 'Name of the line', maxlength: 120 });
        const kind = OX.el('select', {},
          OX.el('option', { value: 'main', text: 'Main line' }),
          OX.el('option', { value: 'sideline', text: 'Sideline' }));
        const sides = OX.el('div', { class: 'seg' });
        const drawSides = () => sides.replaceChildren(...COLORS.map(c => OX.el('button', {
          class: c === color ? 'active' : '', onclick: () => { color = c; drawSides(); },
        }, OX.el('span', { class: `dot ${c}` }), `As ${label(c)}`)));
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
          sides, name, kind,
          OX.el('div', { class: 'btns' },
            OX.el('button', { class: 'btn primary', onclick: save, text: 'Save' }),
            OX.el('button', { class: 'btn', onclick: () => { form = null; render(); }, text: 'Cancel' }),
            status));
        render();
        name.focus();
        try {
          const found = await OX.bridge.api('GET', `/openings/classify?moves_san=${encodeURIComponent(line.join(' '))}`);
          if (found?.name && !name.value) name.value = found.name;
        } catch { /* type a name */ }
      }

      function render() {
        if (!index || !position) return;
        const entry = index.positions.get(position.key);
        const sections = COLORS.map(color => sideSection(entry, color)).filter(Boolean);
        const ended = COLORS.filter(c => entry?.reached[c]);
        const status = sections.length
          ? null
          : OX.el('div', { class: ended.length ? 'ok' : 'dim' },
            ended.length
              ? `End of your prepared line${entry.ends.length ? `: ${entry.ends.map(b => b.name).join(', ')}` : ''}.`
              : 'Not in your repertoire.');
        body.replaceChildren(...leftBanner(entry), ...sections, ...(status ? [status] : []), ...[linesSection(), footer()].filter(Boolean));
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
            previous = { position, entry: index?.positions.get(position.key) };
            editing = deleting = null;
            showAllLines = false;
            form = null;
          }
          position = next;
          await refresh();
        },
        destroy() { token++; },
      };
    },
  });
})();
