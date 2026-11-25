#!/usr/bin/env node
// Tests how the page's requests to Lichess's engine service are paced
// (src/page-bridge.js). Lichess's service refuses an address that asks too
// often, and Lichess then shows "Your Stockfish error: TypeError: Failed to
// fetch": stepping through a game at a clicking pace did that. Needs nothing
// running:
//
//   node extension/scripts/engine-pacing-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/page-bridge.js'), 'utf8');
const relaySource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/engine-relay.js'), 'utf8');
const ANALYSE = 'https://engine.lichess.ovh/api/external-engine/eei_test/analyse';

// A page with a clock the test moves by hand: timers run when their time comes.
function page({ refuse = () => false, status = () => 200, storage = new Map(), site, relay, chrome } = {}) {
  let now = 1_000_000;
  let timers = [];
  const sent = [];
  const window = {
    site,
    fetch(input, init) {
      const url = String(input);
      sent.push({ url, at: now });
      if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
      if (refuse(url, sent.length)) return Promise.reject(new TypeError('Failed to fetch'));
      const code = status(url, sent.length);
      return Promise.resolve({ ok: code === 200, status: code, url });
    },
  };
  // The page's document, with engine-relay.js's side played by `relay`
  // (ask, reply) when given: it is handed every "ox-engine" request.
  const listeners = new Map();
  const attributes = new Map();
  const asks = [];
  const document = {
    hidden: false,
    addEventListener(type, run) { listeners.set(type, [...(listeners.get(type) || []), run]); },
    removeEventListener(type, run) { listeners.set(type, (listeners.get(type) || []).filter(other => other !== run)); },
    dispatchEvent(event) { for (const run of listeners.get(event.type) || []) run(event); return true; },
    documentElement: {
      hasAttribute: name => attributes.has(name), getAttribute: name => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, String(value)), removeAttribute: name => attributes.delete(name),
    },
  };
  const reply = message => document.dispatchEvent(new CustomEvent('ox-engine-reply', { detail: JSON.stringify(message) }));
  if (relay) {
    document.addEventListener('ox-engine', event => {
      const ask = JSON.parse(event.detail);
      asks.push(ask);
      if (ask.op === 'analyse') document.documentElement.setAttribute('data-ox-engine-ack', ask.id);
      relay(ask, kind => text => reply({ id: ask.id, kind, text }));
    });
  }
  const context = vm.createContext({
    window,
    document, CustomEvent, Response, ReadableStream, TextEncoder,
    location: { href: 'https://lichess.org/analysis' },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, String(value)); } },
    setTimeout: (run, ms = 0) => { const timer = { run, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: timer => { timers = timers.filter(other => other !== timer); },
    setInterval: () => 0, clearInterval() {},
    Date: { now: () => now },
    URL, DOMException, AbortController, Promise, JSON, Math, Number, String, Set, console,
  });
  vm.runInContext(source, context, { filename: 'src/page-bridge.js' });
  // The real engine-relay.js, in its own (isolated) world on the same document.
  if (chrome) vm.runInContext(relaySource, vm.createContext({ chrome, document, CustomEvent, JSON, Map, Boolean, globalThis: {} }), { filename: 'src/engine-relay.js' });
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return {
    sent, storage, window, settle, asks,
    ask(url = ANALYSE, init = { method: 'post', body: '{}' }) {
      const state = { done: false, error: null, value: null };
      window.fetch(url, init).then(value => { state.done = true; state.value = value; }, error => { state.done = true; state.error = error; });
      return state;
    },
    // Moves the clock on, running the timers that fall due, in order.
    async advance(ms) {
      const until = now + ms;
      await settle();
      for (;;) {
        const due = timers.filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter(timer => timer !== due);
        now = Math.max(now, due.at);
        due.run();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

let passed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log(`  ok  ${name}`); }
  catch (error) { console.log(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}

await test('the first positions are asked at once, later ones wait their turn', async () => {
  const p = page();
  for (let i = 0; i < 12; i++) p.ask();
  await p.settle();
  assert.equal(p.sent.length, 12, 'twelve positions in a row go straight out');
  const late = p.ask();
  await p.settle();
  assert.equal(p.sent.length, 12, 'the thirteenth waits');
  await p.advance(1400);
  assert.equal(p.sent.length, 12, 'still waiting just before its turn');
  await p.advance(200);
  assert.equal(p.sent.length, 13, 'and goes out a second and a half later');
  assert.equal(late.value?.ok, true);
});

await test('stepping for a minute at a clicking pace stays under the limit', async () => {
  // What Lichess's service allowed when measured (Nov 2026), on the low side:
  // 55 requests at once, then 2 a second; a position costs 3.
  const p = page();
  let allowance = 55;
  let previous = null;
  let refused = 0;
  for (let step = 0; step < 150; step++) { // 2.5 positions a second
    previous?.abort(); // Lichess cancels the last position's request
    const before = p.sent.length;
    previous = new AbortController();
    p.ask(ANALYSE, { method: 'post', body: '{}', signal: previous.signal });
    await p.advance(400);
    allowance = Math.min(55, allowance + 0.4 * 2) - (p.sent.length - before) * 3;
    if (allowance < 0) refused++;
  }
  assert.equal(refused, 0, 'never asks for more than the service allows');
  assert.ok(p.sent.length >= 30, `positions are still analysed while stepping (${p.sent.length} of 150)`);
});

await test('a request cancelled while it waits is never sent', async () => {
  const p = page();
  for (let i = 0; i < 12; i++) p.ask();
  const controller = new AbortController();
  const waiting = p.ask(ANALYSE, { method: 'post', body: '{}', signal: controller.signal });
  await p.advance(500);
  controller.abort();
  await p.advance(5000);
  assert.equal(p.sent.length, 12);
  assert.equal(waiting.error?.name, 'AbortError', 'and Lichess is told it was cancelled, as fetch says it');
});

await test('a request already cancelled is not sent either', async () => {
  for (const spent of [0, 12]) {
    const p = page();
    for (let i = 0; i < spent; i++) p.ask();
    const controller = new AbortController();
    controller.abort();
    const state = p.ask(ANALYSE, { method: 'post', body: '{}', signal: controller.signal });
    await p.advance(5000);
    assert.equal(p.sent.length, spent);
    assert.equal(state.error?.name, 'AbortError');
  }
});

await test('visible broker refusals retry, but invalid requests do not', async () => {
  const p = page({ status: (_url, attempt) => [429, 503, 200][attempt - 1] });
  const state = p.ask();
  await p.advance(8000);
  assert.equal(p.sent.length, 3);
  assert.equal(state.value?.status, 200);
  const invalid = page({ status: () => 400 });
  const bad = invalid.ask();
  await invalid.advance(8000);
  assert.equal(invalid.sent.length, 1);
  assert.equal(bad.value?.status, 400);
});

await test('a refused request is tried again before Lichess hears of it', async () => {
  const p = page({ refuse: (url, n) => n <= 2 });
  const state = p.ask();
  await p.advance(1000);
  assert.equal(state.done, false, 'no error after the first refusal');
  await p.advance(8000);
  assert.equal(p.sent.length, 3);
  assert.equal(state.value?.ok, true, 'the third try is answered');
});

await test('a service that stays down is reported to Lichess in the end', async () => {
  const p = page({ refuse: () => true });
  const state = p.ask();
  await p.advance(60_000);
  assert.equal(p.sent.length, 4);
  assert.equal(state.error?.message, 'Failed to fetch');
});

await test('a refusal empties the allowance for the other tabs too', async () => {
  const storage = new Map();
  const first = page({ refuse: () => true, storage });
  first.ask();
  await first.settle();
  const second = page({ storage });
  second.ask();
  await second.settle();
  assert.equal(second.sent.length, 0, 'the other tab waits');
  await second.advance(1600);
  assert.equal(second.sent.length, 1);
});

await test('two tabs share one allowance', async () => {
  const storage = new Map();
  const first = page({ storage });
  const second = page({ storage });
  for (let i = 0; i < 8; i++) { first.ask(); second.ask(); }
  await first.settle();
  assert.equal(first.sent.length + second.sent.length, 12);
});

// Lichess's analysis controller as far as the cloud check reads it (lila
// analyse/src/ctrl.ts canEvalGet: before move 15 or in a study; lib/src/ceval/
// ctrl.ts letCloudWin: the cloud's search is bigger than yours could be).
function lichess({ opening = true, cloudAfter = null, deeper = false, practice = false } = {}) {
  const board = { cloud: false, opening, deeper, practice };
  const site = {
    analysis: {
      canEvalGet: () => board.opening,
      practice: board.practice ? {} : undefined,
      ceval: {
        isDeeper: () => board.deeper, isInfinite: false, opts: {},
        search: { by: { movetime: 8000 } }, lastStarted: { threatMode: false, steps: [{}] },
        letCloudWin: () => board.cloud,
      },
    },
  };
  return { site, board, cloudLands: () => { board.cloud = true; }, cloudAfter };
}

await test('an opening position the cloud already covers costs nothing (stepping through an opening)', async () => {
  // Measured in Chrome (Nov 2026): Lichess sends every opening position to
  // your Stockfish too, and stops it after the first line because the cloud's
  // search is far bigger. Fourteen such positions used up the whole allowance,
  // so the middlegame after them showed "Loading engine" at every other move.
  const l = lichess();
  const p = page({ site: l.site });
  for (let i = 0; i < 14; i++) {
    l.board.cloud = false;
    const controller = new AbortController();
    const state = p.ask(ANALYSE, { method: 'post', body: '{}', signal: controller.signal });
    await p.advance(60);
    l.cloudLands(); // Lichess's cloud answer arrives ~50 ms after the move
    await p.advance(500);
    assert.equal(state.error?.name, 'AbortError', 'Lichess hears what it hears when it stops a search itself');
    controller.abort();
  }
  assert.equal(p.sent.length, 0, 'none of the opening positions was sent');
  l.board.opening = false; l.board.cloud = false;
  for (let i = 0; i < 12; i++) p.ask();
  await p.settle();
  assert.equal(p.sent.length, 12, 'the middlegame after them still has the whole allowance');
});

await test('an opening position the cloud does not know is asked after a short wait', async () => {
  const l = lichess();
  const p = page({ site: l.site });
  const state = p.ask();
  await p.advance(200);
  assert.equal(p.sent.length, 0, 'waits for the cloud first');
  await p.advance(200);
  assert.equal(p.sent.length, 1, 'then asks your Stockfish');
  assert.equal(state.value?.ok, true);
});

await test('a position past the opening is asked at once', async () => {
  const l = lichess({ opening: false });
  const p = page({ site: l.site });
  p.ask();
  await p.settle();
  assert.equal(p.sent.length, 1);
});

await test('Go deeper, Practice and a changed Lichess always ask your Stockfish', async () => {
  for (const options of [{ deeper: true }, { practice: true }]) {
    const l = lichess(options);
    l.cloudLands();
    const p = page({ site: l.site });
    const state = p.ask();
    await p.advance(400);
    assert.equal(p.sent.length, 1, JSON.stringify(options));
    assert.equal(state.value?.ok, true);
  }
  const broken = [
    { analysis: { canEvalGet() { throw new Error('changed'); } } },
    { analysis: { canEvalGet: () => true, ceval: {} } },
    { analysis: { canEvalGet: () => true, ceval: { letCloudWin() { throw new Error('changed'); }, search: { by: {} }, lastStarted: {} } } },
  ];
  for (const site of broken) {
    const p = page({ site });
    const state = p.ask();
    await p.advance(400);
    assert.equal(p.sent.length, 1);
    assert.equal(state.value?.ok, true);
  }
});

// --- answered on this computer (engine-relay.js → background → the app) ----
const RESULT = '{"time":5,"depth":9,"nodes":900,"pvs":[{"moves":["e2e4"],"cp":20,"depth":9}]}\n';
const FINAL = '{"time":6,"depth":9,"nodes":950,"pvs":[{"moves":["e2e4"],"cp":20,"depth":9}],"bestmove":"e2e4"}\n';
// A relay whose app answers every request at once, in two pieces.
const answering = (ask, say) => {
  if (ask.op !== 'analyse') return;
  say('start')();
  say('chunk')(RESULT.slice(0, 20));
  say('chunk')(RESULT.slice(20) + FINAL);
  say('end')();
};
const body = JSON.stringify({ clientSecret: 'secret', work: { sessionId: 's', moves: ['e2e4'], movetime: 8000 } });

await test('with the app there, Lichess\'s engine service is never asked', async () => {
  const l = lichess(); // an opening position: no cloud wait either
  const p = page({ relay: answering, site: l.site });
  const state = p.ask(ANALYSE, { method: 'post', body });
  await p.settle();
  assert.equal(state.value?.status, 200);
  assert.equal(await state.value.text(), RESULT + FINAL, 'Lichess reads the app\'s lines as they were sent');
  assert.equal(p.sent.length, 0);
  assert.equal(p.asks[0].engineId, 'eei_test', 'the engine Lichess asked for');
  assert.deepEqual(p.asks[0].work, JSON.parse(body).work, 'the work as Lichess sent it, without its secret');
  assert.equal(JSON.stringify(p.asks).includes('secret'), false);
});

await test('stepping through a whole game quickly asks the service nothing', async () => {
  const p = page({ relay: answering });
  let previous = null;
  for (let step = 0; step < 150; step++) {
    previous?.abort();
    previous = new AbortController();
    const state = p.ask(ANALYSE, { method: 'post', body, signal: previous.signal });
    await p.advance(400);
    assert.equal(state.value?.status, 200, `move ${step} answered at once`);
  }
  assert.equal(p.sent.length, 0);
  assert.equal(p.storage.has('ox.engineBudget'), false, 'no allowance used');
});

await test('lines arrive while the search goes on, and stop when Lichess cancels', async () => {
  let say = null;
  const p = page({ relay: (ask, reply) => { if (ask.op === 'analyse') { say = reply; reply('start')(); } } });
  const controller = new AbortController();
  const state = p.ask(ANALYSE, { method: 'post', body, signal: controller.signal });
  await p.settle();
  const reader = state.value.body.getReader();
  say('chunk')(RESULT);
  assert.equal(new TextDecoder().decode((await reader.read()).value), RESULT);
  const next = reader.read();
  controller.abort(); // you moved on
  await assert.rejects(next, error => error.name === 'AbortError', 'read as fetch reports a cancelled body');
  assert.deepEqual(p.asks.at(-1), { op: 'abort', id: p.asks[0].id }, 'the app is told to stop');
  say('chunk')(RESULT); // late lines are dropped quietly
  assert.equal(p.sent.length, 0);
});

await test('a request cancelled before the app answers is cancelled for Lichess and the app', async () => {
  const p = page({ relay: () => {} });
  const controller = new AbortController();
  const state = p.ask(ANALYSE, { method: 'post', body, signal: controller.signal });
  await p.settle();
  controller.abort();
  await p.advance(5000);
  assert.equal(state.error?.name, 'AbortError');
  assert.equal(p.asks.at(-1).op, 'abort');
  assert.equal(p.sent.length, 0, 'and not sent to the service instead');
});

await test('the app not running, or not its engine: asked of the service as before', async () => {
  for (const kind of ['unavailable', 'error']) {
    const p = page({ relay: (ask, say) => { if (ask.op === 'analyse') say(kind)(); } });
    const state = p.ask(ANALYSE, { method: 'post', body });
    await p.settle();
    assert.equal(p.sent.length, 1, kind);
    assert.equal(state.value?.ok, true);
  }
  // A relay that answers later (the background script took its time).
  let later = null;
  const slow = page({ relay: (ask, say) => { if (ask.op === 'analyse') later = say; } });
  const state = slow.ask(ANALYSE, { method: 'post', body });
  await slow.settle();
  assert.equal(slow.sent.length, 0);
  later('unavailable')();
  await slow.settle();
  assert.equal(slow.sent.length, 1);
  assert.equal(state.value?.ok, true);
});

await test('no relay in the page (the extension was updated): the service as before', async () => {
  const p = page();
  const state = p.ask(ANALYSE, { method: 'post', body });
  await p.settle();
  assert.equal(p.sent.length, 1);
  assert.equal(state.value?.ok, true);
  assert.equal(p.window.document, undefined);
});

await test('the app stopping mid-search is a failed request, as the service failing would be', async () => {
  let say = null;
  const p = page({ relay: (ask, reply) => { if (ask.op === 'analyse') { say = reply; reply('start')(); reply('chunk')(RESULT); } } });
  const state = p.ask(ANALYSE, { method: 'post', body });
  await p.settle();
  const reading = state.value.text();
  say('error')();
  await assert.rejects(reading, error => error.name === 'TypeError');
});

await test('Lichess dropping the body tells the app to stop', async () => {
  const p = page({ relay: (ask, say) => { if (ask.op === 'analyse') say('start')(); } });
  const state = p.ask(ANALYSE, { method: 'post', body });
  await p.settle();
  await state.value.body.cancel();
  assert.equal(p.asks.at(-1).op, 'abort');
});

await test('a request body that is not Lichess\'s goes to the service untouched', async () => {
  const p = page({ relay: answering });
  for (const odd of ['not json', '{}', '{"work":3}', 'null']) p.ask(ANALYSE, { method: 'post', body: odd });
  await p.settle();
  assert.equal(p.sent.length, 4);
  assert.equal(p.asks.length, 0);
});

await test('the real relay carries the request to the background script and back', async () => {
  const ports = [];
  const chrome = {
    runtime: {
      id: 'ext',
      connect({ name }) {
        const on = { message: [], disconnect: [] };
        const port = {
          name, posted: [], closed: false,
          postMessage(message) { port.posted.push(message); },
          disconnect() { port.closed = true; },
          onMessage: { addListener(run) { on.message.push(run); } },
          onDisconnect: { addListener(run) { on.disconnect.push(run); } },
          answer(message) { for (const run of on.message) run(message); },
          drop() { for (const run of on.disconnect) run(); },
        };
        ports.push(port);
        return port;
      },
    },
  };
  const p = page({ chrome });
  const controller = new AbortController();
  const state = p.ask(ANALYSE, { method: 'post', body, signal: controller.signal });
  await p.settle();
  assert.equal(ports.length, 1);
  assert.equal(ports[0].name, 'ox-engine');
  assert.equal(JSON.stringify(ports[0].posted), JSON.stringify([{ engineId: 'eei_test', work: JSON.parse(body).work }]));
  ports[0].answer({ kind: 'start' });
  ports[0].answer({ kind: 'chunk', text: RESULT });
  await p.settle();
  const reader = state.value.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), RESULT);
  controller.abort();
  assert.equal(ports[0].closed, true, 'cancelling closes the port, which aborts the app\'s request');

  // The background script going away before an answer: the service instead.
  const second = p.ask(ANALYSE, { method: 'post', body });
  await p.settle();
  ports[1].drop();
  await p.settle();
  assert.equal(p.sent.length, 1);
  assert.equal(second.value?.ok, true);

  // A relay cut off by an extension update says nothing: the service again.
  chrome.runtime.id = undefined;
  const third = p.ask(ANALYSE, { method: 'post', body });
  await p.settle();
  assert.equal(ports.length, 2);
  assert.equal(p.sent.length, 2);
  assert.equal(third.value?.ok, true);
});

await test('nothing else Lichess fetches is touched', async () => {
  const p = page();
  const others = [
    ['https://lichess.org/api/external-engine', { method: 'post', body: '{}' }],
    ['https://other.example/api/external-engine/eei_test/analyse', { method: 'post', body: '{}' }],
    ['https://explorer.lichess.ovh/masters?fen=x', undefined],
    [ANALYSE, { method: 'get' }],
    [ANALYSE, { method: 'post', body: new Uint8Array(2) }],
    ['/analysis/pgn', { method: 'post', body: 'x' }],
  ];
  for (let round = 0; round < 15; round++) for (const [url, init] of others) p.ask(url, init);
  await p.settle();
  assert.equal(p.sent.length, 90);
});

await test('storage that throws or holds rubbish does not stop the engine', async () => {
  for (const storage of [new Map([['ox.engineBudget', '{oops']]), new Map([['ox.engineBudget', '{"left":"x","at":null}']]),
    new Map([['ox.engineBudget', JSON.stringify({ left: -500, at: 9e15 })]]), new Map([['ox.engineBudget', JSON.stringify({ left: -500, at: 5 })]]),
    new Map([['ox.engineBudget', JSON.stringify({ left: -1e9, at: 999_999 })]])]) {
    const p = page({ storage });
    const state = p.ask();
    await p.advance(2000); // at worst it waits as after a refusal, never for ever
    assert.equal(state.value?.ok, true);
  }
  const broken = page({ storage: { get() { throw new Error('blocked'); }, set() { throw new Error('blocked'); } } });
  const state = broken.ask();
  await broken.settle();
  assert.equal(state.value?.ok, true);
});

await test('put in again after an update, it wraps Lichess\'s fetch only once', async () => {
  const p = page();
  const native = p.window.__oxPageFetch;
  const context = vm.createContext({
    window: p.window, document: { addEventListener() {}, removeEventListener() {}, documentElement: { hasAttribute: () => false } },
    location: { href: 'https://lichess.org/analysis' }, localStorage: { getItem: () => null, setItem() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Date, URL, DOMException, Promise, JSON, Math, Number, String, Set, console,
  });
  vm.runInContext(source, context);
  assert.equal(p.window.__oxPageFetch, native);
});

console.log(process.exitCode ? '\nFAILED' : `\nAll ${passed} engine-pacing tests passed.`);
