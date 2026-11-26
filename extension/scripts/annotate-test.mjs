#!/usr/bin/env node
// Tests "Annotate chapter" (src/annotate-core.js): Lichess's own thresholds
// for ?!, ? and ??, what is counted as analysed, and the document Lichess's
// Publish takes. Needs nothing running:
//
//   node extension/scripts/annotate-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.addEventListener = () => {};
for (const file of ['vendor/chess.js', 'src/anchors.js', 'src/core.js', 'src/annotate-core.js']) {
  vm.runInThisContext(readFileSync(join(src, file), 'utf8'), { filename: file });
}
const { OX, OXChess } = globalThis;
const A = OX.annotate;

let failures = 0;
function test(name, run) {
  try { run(); console.log(`ok    ${name}`); }
  catch (error) { failures++; console.log(`FAIL  ${name}\n${error.stack}`); }
}

// A chapter as page-bridge.js reads it: the main line of `sans` from `fen`,
// with `evals[i]` as position i's result (null: none yet).
function chapter(sans, evals, fen) {
  const chess = new OXChess(fen);
  const start = fen ? 2 * (Number(fen.split(' ')[5]) - 1) + (fen.split(' ')[1] === 'b' ? 1 : 0) : 0;
  const nodes = [{ ply: start, fen: chess.fen(), uci: null, san: null }];
  for (const san of sans) {
    const move = chess.move(san);
    nodes.push({ ply: nodes.length + start, fen: chess.fen(), uci: move.from + move.to + (move.promotion || ''), san: move.san });
  }
  nodes.forEach((node, i) => {
    const e = evals[i];
    node.ceval = e ? { cp: e.cp ?? null, mate: e.mate ?? null, depth: e.depth ?? 30, nodes: e.nodes ?? 1000,
      engineId: 'eei_mine', cloud: !!e.cloud, pv: e.pv } : null;
    node.eval = e?.published || null;
  });
  return { studyId: 'study123', chapterId: 'chap1234', user: 'avebabur', canContribute: true, nodes };
}

// 1. e4 e5 2. Qh5 Nc6 3. Qxf7+?? Kxf7: the queen is lost on move 3.
const QUEEN_HANG = ['e4', 'e5', 'Qh5', 'Nc6', 'Qxf7+', 'Kxf7'];
const hangEvals = () => [
  { cp: 20, pv: ['e2e4'] },
  { cp: 30, pv: ['e7e5'] },
  { cp: 25, pv: ['d1h5'] },
  { cp: -20, pv: ['b8c6'] },
  { cp: 0, pv: ['h5e2', 'g8f6', 'd2d3'] },       // before 3. Qxf7+: Qe2 was best
  { cp: -900, pv: ['e8f7'] },
  { cp: -950, pv: ['g1f3'] },
];

test("Lichess's thresholds: inaccuracy, mistake, blunder", () => {
  assert.equal(A.judgment({ cp: 0 }, { cp: -50 }, true), null);
  assert.equal(A.judgment({ cp: 0 }, { cp: -60 }, true), 'Inaccuracy');
  assert.equal(A.judgment({ cp: 0 }, { cp: -120 }, true), 'Mistake');
  assert.equal(A.judgment({ cp: 0 }, { cp: -170 }, true), 'Blunder');
  assert.equal(A.judgment({ cp: 0 }, { cp: 170 }, false), 'Blunder');
  assert.equal(A.judgment({ cp: -900 }, { cp: -1500 }, true), null); // already lost
  assert.equal(A.judgment({ cp: 0 }, { mate: -3 }, true), 'Blunder');
  assert.equal(A.judgment({ mate: 2 }, { cp: 1200 }, true), 'Inaccuracy');
  assert.equal(A.judgment({ mate: 1 }, { mate: 0 }, true), null);    // gave checkmate
});

test('counts the moves with a result and names the missing and the shallowest', () => {
  const evals = hangEvals();
  evals[3] = null;
  evals[5] = null;
  evals[2] = { cp: 25, pv: ['d1h5'], depth: 14 };
  const state = A.status(chapter(QUEEN_HANG, evals));
  assert.equal(state.total, 6);
  assert.equal(state.analysed, 4);
  assert.deepEqual(state.missing, [{ ply: 3, label: '2. Qh5' }, { ply: 5, label: '3. Qxf7+' }]);
  assert.deepEqual(state.shallowest, { ply: 2, label: '1… e5', depth: 14 });
  assert.equal(state.ready, false);
  assert.equal(A.status(chapter(QUEEN_HANG, hangEvals())).ready, true);
});

test('only the judged move gets a line; scores are from White\'s side', () => {
  const doc = A.build(chapter(QUEEN_HANG, hangEvals()), new Date('2026-11-26T10:00:00Z'));
  assert.equal(doc.id, 'chap1234');
  assert.equal(doc.studyId, 'study123');
  assert.equal(doc.startPly, 0);
  assert.equal(doc.date, '2026-11-26T10:00:00.000Z');
  assert.deepEqual(doc.initialEval, { cp: 20 });
  assert.deepEqual(doc.infos.map(i => i.ply), [1, 2, 3, 4, 5, 6]);
  const judged = doc.infos.filter(i => i.variation.length);
  assert.deepEqual(judged.map(i => i.ply), [5]);
  assert.deepEqual(judged[0].eval, { cp: -900, best: 'h5e2' });
  assert.deepEqual(judged[0].variation, ['Qe2', 'Nf6', 'd3']);
  assert.deepEqual(doc.infos[5].eval, { cp: -950 });
  assert.deepEqual(doc.engine, { nodesPerMove: 1000, id: 'eei_mine', userId: 'avebabur', engineVersion: 'Your Stockfish' });
});

test('a move that is the engine\'s own best is never given a line', () => {
  const evals = hangEvals();
  evals[4] = { cp: 0, pv: ['h5f7'] }; // the engine liked Qxf7+ too
  const doc = A.build(chapter(QUEEN_HANG, evals));
  assert.ok(doc.infos.every(i => !i.variation.length));
});

test('castling written as king-takes-rook is read, and given back as e1g1 / O-O', () => {
  const fen = 'r3k2r/pppq1ppp/8/8/8/8/PPPQ1PPP/R3K2R w KQkq - 0 10';
  const data = chapter(['Qd6'], [
    { cp: 0, pv: ['e1h1', 'e8c8'] },
    { cp: -400, pv: ['d7d6'] },
  ], fen);
  const doc = A.build(data);
  assert.equal(doc.startPly, 18);
  assert.equal(doc.infos[0].ply, 19);
  assert.equal(doc.infos[0].eval.best, 'e1g1');
  assert.deepEqual(doc.infos[0].variation, ['O-O', 'O-O-O']);
});

test('a checkmate needs no engine and is mate 0', () => {
  const data = chapter(['f3', 'e5', 'g4', 'Qh4#'], [
    { cp: 0, pv: ['e2e4'] }, { cp: -50, pv: ['e7e5'] }, { cp: -60, pv: ['e1f2'] },
    { mate: -1, pv: ['d8h4'] }, null,
  ]);
  assert.equal(A.status(data).ready, true);
  const doc = A.build(data);
  assert.deepEqual(doc.infos[3].eval, { mate: 0, mateGiven: false });
});

test("the cloud's node counts are left out and the total fits Lichess", () => {
  const evals = hangEvals().map((e, i) => ({ ...e, nodes: i ? 4e9 : 9e10, cloud: !i }));
  const doc = A.build(chapter(QUEEN_HANG, evals));
  assert.equal(doc.engine.nodesPerMove, 2 ** 31 - 1);
  const small = A.build(chapter(QUEEN_HANG, hangEvals().map((e, i) => ({ ...e, nodes: i ? 2000 : 9e10, cloud: !i }))));
  assert.equal(small.engine.nodesPerMove, 2000);
});

test('a move without your engine\'s result keeps what an earlier publish gave it', () => {
  const evals = hangEvals();
  evals[2] = { published: { cp: 30, mate: null, best: null } };
  evals[2].pv = undefined;
  const data = chapter(QUEEN_HANG, evals);
  data.nodes[2].ceval = null;
  const state = A.status(data);
  assert.equal(state.ready, true);
  assert.equal(state.annotated, true);
  assert.deepEqual(A.build(data).infos[1].eval, { cp: 30 });
});

test('a search cut off at once (depth 1, as Lichess keeps it from quick stepping) is not a result', () => {
  // Lichess saves every engine result in the browser (IndexedDB analyse-ceval)
  // and puts it back on the moves when the chapter is opened again, also the
  // depth-1 line of a search cancelled after a millisecond. Counted, those
  // made the chapter "ready" and published nonsense marks.
  const evals = hangEvals();
  evals[1] = { cp: 8, pv: ['e7e5'], depth: 1 };
  evals[3] = { cp: 19, pv: ['b8c6'], depth: 11 };
  const state = A.status(chapter(QUEEN_HANG, evals));
  assert.equal(state.ready, false);
  assert.deepEqual(state.missing, [{ ply: 1, label: '1. e4', depth: 1 }, { ply: 3, label: '2. Qh5', depth: 11 }]);
  assert.throws(() => A.build(chapter(QUEEN_HANG, evals)), /No result for 1\. e4/);
  // A mate the engine has found holds at any depth; an earlier publish still counts.
  evals[1] = { mate: 5, pv: ['e7e5'], depth: 3 };
  evals[3] = { cp: 19, pv: ['b8c6'], depth: 2, published: { cp: 15, mate: null, best: null } };
  assert.equal(A.status(chapter(QUEEN_HANG, evals)).ready, true);
  assert.deepEqual(A.build(chapter(QUEEN_HANG, evals)).infos[2].eval, { cp: 15 });
});

test('build refuses a chapter with a move still missing', () => {
  const evals = hangEvals();
  evals[4] = null;
  assert.throws(() => A.build(chapter(QUEEN_HANG, evals)), /No result for 2… Nc6/);
});

if (failures) { console.log(`FAIL  ${failures} annotate test(s)`); process.exit(1); }
console.log('All annotate tests passed');
