// Your repertoire as positions, not move orders.
//
// A saved line is a list of moves, but what you prepared belongs to the
// POSITIONS on it: 1.d4 Nf6 2.c4 e6 and 1.c4 e6 2.d4 Nf6 reach the same
// position, and whatever you prepared there holds for both. So everything the
// repertoire box shows is looked up by position (OX.positionKey), never by the
// moves that led there. This file is that lookup and the questions asked of
// it; it touches no page, so scripts/repertoire-test.mjs can run it in Node.
(() => {
  const OX = (globalThis.OX = globalThis.OX || {});
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const LINE_PLIES = 10;

  // The moves played out from the normal start: { sans, ucis, keys }, where
  // keys[n] is the position after n moves. null when a move is not legal.
  function replay(sans) {
    const chess = new globalThis.OXChess(START);
    const keys = [OX.positionKey(START)];
    const ucis = [];
    try {
      for (const san of sans) {
        const move = chess.move(san);
        ucis.push(move.from + move.to + (move.promotion || ''));
        keys.push(OX.positionKey(chess.fen()));
      }
    } catch { return null; }
    return { sans: [...sans], ucis, keys };
  }

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
        const played = replay((raw.moves_san || '').split(/\s+/).filter(Boolean));
        if (!played) continue; // a line the app couldn't replay: leave it out here
        const branch = { ...raw, color, ...played };
        branches.push(branch);
        const seen = new Set(); // a line that repeats a position passes through it once
        branch.keys.forEach((key, at) => {
          if (seen.has(key)) return;
          seen.add(key);
          if (!through.has(key)) through.set(key, []);
          through.get(key).push({ branch, at });
        });
        entry(branch.keys[branch.keys.length - 1]).ends.push(branch);
      }
    }
    return { positions, through, branches };
  }

  const sorted = map => [...map.values()].sort((a, b) => Number(b.main) - Number(a.main));

  // Your main line from a position: the main move at each position on the way.
  function mainLine(index, key, color) {
    const line = [];
    const seen = new Set([key]);
    let at = key;
    while (line.length < LINE_PLIES) {
      const next = sorted(index.positions.get(at)?.moves[color] || new Map())[0];
      if (!next || seen.has(next.after)) break; // the end, or a repetition
      line.push(next);
      seen.add(next.after);
      at = next.after;
    }
    return line;
  }

  // Where the line on the board left `color`'s repertoire, read from the whole
  // line (so it is the same answer after one step, a jump, or a page load).
  //   null                      the position on the board is prepared (by any
  //                             move order), or the line never was
  //   { at, past: true }        the line ran on past the end of a prepared one
  //   { at, san, mover, book }  move number `at` (0 = the first) left it: `san`
  //                             was played by `mover`, where `book` was prepared
  function leftAt(index, path, color) {
    const last = path.keys.length - 1;
    const reached = at => !!index.positions.get(path.keys[at])?.reached[color];
    if (last < 1 || reached(last)) return null;
    let at = last - 1;
    while (at >= 0 && !reached(at)) at--;
    if (at < 0) return null;
    const here = index.positions.get(path.keys[at]);
    const book = sorted(here.moves[color]);
    if (!book.length) return { at, past: true, ends: here.ends.filter(b => b.color === color) };
    return { at, past: false, san: path.sans[at], mover: at % 2 === 0 ? 'white' : 'black', book };
  }

  // The saved lines that could be made to run on to the board's position:
  // those the board's line starts with, and those whose last position lies on
  // it by another move order (they keep their own moves and get the rest).
  // Each: { branch, moves, added, transposed }, the closest first.
  function extensions(index, path) {
    const last = path.keys.length - 1;
    const saved = new Set(index.branches.map(b => `${b.color} ${b.sans.join(' ')}`));
    const found = [];
    for (const branch of index.branches) {
      const samePrefix = branch.sans.length < path.sans.length && branch.sans.every((san, i) => san === path.sans[i]);
      const at = samePrefix ? branch.sans.length : path.keys.lastIndexOf(branch.keys[branch.keys.length - 1]);
      if (at < 1 || at >= last) continue;
      const moves = samePrefix ? path.sans : [...branch.sans, ...path.sans.slice(at)];
      if (saved.has(`${branch.color} ${moves.join(' ')}`)) continue; // that line exists already
      found.push({ branch, moves, added: last - at, transposed: !samePrefix });
    }
    return found.sort((a, b) => a.added - b.added || Number(a.transposed) - Number(b.transposed));
  }

  // Whether a saved line reaches its position number `at` by other moves than
  // the board's line did.
  const otherOrder = (branch, at, path) =>
    at !== path.sans.length || branch.sans.slice(0, at).some((san, i) => san !== path.sans[i]);

  // "3. Nf3 Nc6 4. d4" for moves starting `ply` moves into the game.
  function numberFrom(ply, sans) {
    return sans.map((san, i) => {
      const n = ply + i;
      if (n % 2 === 0) return `${n / 2 + 1}. ${san}`;
      return i === 0 ? `${(n + 1) / 2}… ${san}` : san;
    }).join(' ');
  }

  const plain = name => (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // Many lines share a name ("Caro-Kann Defense" twice). For those: the moves
  // where each one parts from the others of its name. Map(branch id -> text).
  function tellApart(branches) {
    const groups = new Map();
    for (const branch of branches) {
      const key = `${branch.color} ${plain(branch.name)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(branch);
    }
    const out = new Map();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      let shared = Math.min(...group.map(b => b.sans.length));
      for (let i = 0; i < shared; i++) {
        if (group.some(b => b.sans[i] !== group[0].sans[i])) { shared = i; break; }
      }
      for (const branch of group) {
        const from = Math.max(0, Math.min(shared, branch.sans.length - 1));
        const shown = branch.sans.slice(from, from + 4);
        out.set(branch.id, numberFrom(from, shown) + (from + shown.length < branch.sans.length ? ' …' : ''));
      }
    }
    return out;
  }

  OX.rep = { START, replay, buildIndex, sorted, mainLine, leftAt, extensions, otherOrder, numberFrom, tellApart, plain };
})();
