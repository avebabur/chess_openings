#!/usr/bin/env node
// Tests how the repertoire is looked up (src/repertoire-index.js), above all
// transpositions: the same position reached by another move order must show
// what was prepared for it. Needs nothing running:
//
//   node extension/scripts/repertoire-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.addEventListener = () => {}; // core.js listens for 'pageshow'
for (const file of ['vendor/chess.js', 'src/anchors.js', 'src/core.js', 'src/repertoire-index.js']) {
  vm.runInThisContext(readFileSync(join(src, file), 'utf8'), { filename: file });
}
const { OX, OXChess } = globalThis;
const R = OX.rep;

// What GET /api/repertoire/tree answers for one colour, from a list of lines.
function tree(color, lines) {
  const root = { children: [] };
  const byPath = new Map([['', root]]);
  const branches = lines.map(([id, name, moves, label = 'main']) => {
    const chess = new OXChess();
    const path = [];
    for (const san of moves.split(' ')) {
      const before = chess.fen();
      const move = chess.move(san);
      const parent = byPath.get(path.join(' '));
      path.push(san);
      if (!byPath.has(path.join(' '))) {
        const node = { san, uci: move.from + move.to + (move.promotion || ''), fen_before: before, fen_after: chess.fen(), label: 'sideline', children: [] };
        parent.children.push(node);
        byPath.set(path.join(' '), node);
      }
      if (label === 'main') byPath.get(path.join(' ')).label = 'main';
    }
    return { id, name, moves_san: moves, label, color };
  });
  return { color, root, branches };
}
const key = moves => R.replay(moves ? moves.split(' ') : []).keys.at(-1);
const path = moves => R.replay(moves.split(' '));
const sans = moves => moves.map(m => m.san);

let passed = 0;
function test(name, run) {
  try { run(); passed++; console.log(`  ok  ${name}`); }
  catch (error) { console.log(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}

// The Nimzo by its usual order, and the same position after 2...e6 by the
// English order, saved as a line of its own that stops there.
const NIMZO = 'd4 Nf6 c4 e6 Nc3 Bb4';
const ENGLISH = 'c4 e6 d4 Nf6';
const white = tree('white', [[1, 'Nimzo-Indian Defense', NIMZO], [2, 'English into the Nimzo', ENGLISH, 'sideline']]);
const black = tree('black', []);
const index = R.buildIndex([white, black]);
const [nimzo, english] = index.branches;

test('a position has one key whatever the move order', () => {
  assert.equal(key('d4 Nf6 c4 e6'), key(ENGLISH));
  assert.equal(key('d4 Nf6 c4 e6'), key('d4 e6 c4 Nf6'));
  assert.notEqual(key('d4 Nf6 c4 e6'), key('d4 Nf6 c4'));
});

test('the key ignores the en-passant square, which Lichess and the app may write differently', () => {
  const withSquare = 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
  const without = 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  assert.equal(OX.positionKey(withSquare), OX.positionKey(without));
});

test('what was prepared shows after another move order', () => {
  const here = index.positions.get(key(ENGLISH));
  assert.deepEqual(sans(R.sorted(here.moves.white)), ['Nc3']);
  assert.equal(here.reached.white, true);
  assert.deepEqual(sans(R.mainLine(index, key(ENGLISH), 'white')), ['Nc3', 'Bb4']);
  // ...and by an order no line was saved with at all.
  assert.deepEqual(sans(R.sorted(index.positions.get(key('d4 e6 c4 Nf6')).moves.white)), ['Nc3']);
});

test('both lines pass through the shared position, and the one that got there differently says so', () => {
  const through = index.through.get(key(ENGLISH));
  assert.deepEqual(through.map(t => [t.branch.id, t.at]), [[1, 4], [2, 4]]);
  const board = path(ENGLISH);
  assert.equal(R.otherOrder(nimzo, 4, board), true);
  assert.equal(R.otherOrder(english, 4, board), false);
  // The rest of the Nimzo can be played from the English order's position.
  assert.deepEqual(nimzo.ucis.slice(4), ['b1c3', 'f8b4']);
});

test('no warning while the board is in the repertoire, by any order', () => {
  for (const moves of [ENGLISH, 'd4 e6 c4 Nf6', `${ENGLISH} Nc3 Bb4`, 'd4', 'c4 e6 d4']) {
    assert.equal(R.leftAt(index, path(moves), 'white'), null, moves);
  }
});

test('leaving the repertoire is found from the whole line, not from the last step', () => {
  // Your own move, after a transposition.
  let left = R.leftAt(index, path(`${ENGLISH} Nf3`), 'white');
  assert.deepEqual([left.at, left.san, left.mover, sans(left.book)], [4, 'Nf3', 'white', ['Nc3']]);
  // Many moves later the answer is still where it happened.
  left = R.leftAt(index, path(`${ENGLISH} Nf3 b6 g3 Bb7 Bg2`), 'white');
  assert.deepEqual([left.at, left.san, sans(left.book)], [4, 'Nf3', ['Nc3']]);
  // The opponent's move.
  left = R.leftAt(index, path('d4 Nf6 c4 e6 Nc3 d5'), 'white');
  assert.deepEqual([left.at, left.san, left.mover, sans(left.book)], [5, 'd5', 'black', ['Bb4']]);
  // Out, and back in by transposition: no warning at the end.
  assert.equal(R.leftAt(index, path('d4 d5 c4 e6 Nc3 Nf6'), 'white')?.at, 1);
  assert.equal(R.leftAt(index, path('d4 e6'), 'white').at, 1);
  assert.equal(R.leftAt(index, path('d4 e6 c4 Nf6'), 'white'), null);
});

test('running past the end of a prepared line is not "leaving" it', () => {
  const left = R.leftAt(index, path(`${NIMZO} e3 O-O`), 'white');
  assert.deepEqual([left.at, left.past, left.ends.map(b => b.id)], [6, true, [1]]);
});

test('a colour with no lines gives no warning', () => {
  assert.equal(R.leftAt(index, path('e4 e5'), 'black'), null);
});

test('a line can be extended from a position it reaches by another order', () => {
  // On the board: the English order, on through the Nimzo, one move further.
  const found = R.extensions(index, path(`${ENGLISH} Nc3 Bb4 e3`));
  assert.deepEqual(found.map(f => [f.branch.id, f.added, f.transposed]), [[1, 1, true], [2, 3, false]]);
  assert.equal(found[0].moves.join(' '), `${NIMZO} e3`);          // keeps its own order
  assert.equal(found[1].moves.join(' '), `${ENGLISH} Nc3 Bb4 e3`);
  // Nothing to extend when the board is not past the line's end.
  assert.deepEqual(R.extensions(index, path(ENGLISH)).map(f => f.branch.id), []);
});

test('an extension that would only repeat a saved line is not offered', () => {
  const both = R.buildIndex([tree('white', [[1, 'A', 'e4 e5'], [2, 'B', 'e4 e5 Nf3']]), black]);
  assert.deepEqual(R.extensions(both, path('e4 e5 Nf3')).map(f => f.branch.id), []);
});

test('a line that repeats a position does not loop or count twice', () => {
  const shuffle = R.buildIndex([tree('white', [[1, 'Shuffle', 'Nf3 Nf6 Ng1 Ng8 Nf3 Nf6 d4']]), black]);
  assert.equal(shuffle.through.get(key('')).length, 1);
  assert.ok(R.mainLine(shuffle, key(''), 'white').length <= 10);
});

test('lines that share a name are told apart by their moves', () => {
  const same = R.buildIndex([white, tree('black', [
    [5, 'Caro Kann Defense', 'e4 c6 d4 d5 e5 Bf5'],
    [6, 'Caro-Kann Defense', 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3'],
    [7, 'French Defense', 'e4 e6'],
  ])]);
  const apart = R.tellApart(same.branches);
  assert.equal(apart.get(5), '3. e5 Bf5');
  assert.equal(apart.get(6), '3. Nc3 dxe4 4. Nxe4 Bf5 …');
  assert.equal(apart.has(7), false);
  assert.equal(R.numberFrom(5, ['Bb4', 'e3']), '3… Bb4 4. e3');
});

console.log(process.exitCode ? '\nSomething failed.' : `\nAll ${passed} repertoire checks passed.`);
