import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function worker(initialTabs = [], { loadedBuild, build, rejectFirstPause = false, rejectFirstResume = false, analyse } = {}) {
  const tabs = new Map(initialTabs.map(tab => [tab.id, tab]));
  const engine = [];
  const broadcasts = [];
  const recovered = [];
  const scheduled = [];
  let alarm = null;
  const event = () => ({ addListener(listener) { this.run = listener; } });
  const storage = (data = {}) => {
    return { async get(key) { return { [key]: data[key] }; }, async set(value) { Object.assign(data, value); } };
  };
  const chrome = {
    storage: { session: storage(), local: storage({ loadedBuild }) },
    alarms: { onAlarm: event(), async get() { return alarm; }, create() { alarm = true; } },
    action: { onClicked: event(), async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
    runtime: { onStartup: event(), onInstalled: event(), onMessage: event(), onConnect: event() },
    scripting: { async executeScript({ target }) { return [{ result: tabs.get(target.tabId)?.live }]; } },
    tabs: {
      onRemoved: event(), onReplaced: event(), onUpdated: event(),
      async get(id) { return tabs.get(id); },
      async query() { return [...tabs.values()].filter(tab => tab.url.startsWith('https://lichess.org/')); },
      async sendMessage(id, message) {
        if (message.type === 'ox-paused') broadcasts.push([id, message.paused]);
        if (message.type === 'ox-engine-resumed') recovered.push(id);
      },
    },
  };
  const asked = [];
  const context = {
    AbortSignal, AbortController, URL, chrome, TextDecoder,
    importScripts() {},
    OX_createBackendClient: () => ({ async api() { return { ok: true, data: { build } }; } }),
    setTimeout(callback) { return scheduled.push(callback) - 1; },
    clearTimeout(id) { scheduled[id] = null; },
    async fetch(url, options) {
      if (url.endsWith('/lichess-engine/analyse')) {
        asked.push({ body: JSON.parse(options.body), signal: options.signal });
        if (!analyse) throw new TypeError('Failed to fetch');
        return analyse(options);
      }
      if (url.endsWith('/paused')) {
        const { paused } = JSON.parse(options.body);
        engine.push(paused);
        if (paused && rejectFirstPause) {
          rejectFirstPause = false;
          return { ok: false };
        }
        if (!paused && rejectFirstResume) {
          rejectFirstResume = false;
          return { ok: false };
        }
      }
      return { ok: true };
    },
  };
  // The real anchors.js (the worker imports it): the live-game selectors and
  // the list of pages whose address only looks like a game's.
  const source = file => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  runInNewContext(`${source('anchors.js')}\n${source('background.js')}`, context);
  // A content script's port (engine-relay.js) asking for analysis.
  function connect(tabId, url = tabs.get(tabId)?.url) {
    const got = [];
    const listeners = { message: [], disconnect: [] };
    const port = {
      name: 'ox-engine', sender: { tab: { id: tabId, url }, url },
      postMessage(message) { got.push(message); },
      disconnect() { port.closed = true; },
      onMessage: { addListener(run) { listeners.message.push(run); }, removeListener(run) { listeners.message = listeners.message.filter(o => o !== run); } },
      onDisconnect: { addListener(run) { listeners.disconnect.push(run); } },
    };
    chrome.runtime.onConnect.run(port);
    return {
      got, port,
      send(message) { for (const run of [...listeners.message]) run(message); },
      close() { for (const run of listeners.disconnect) run(); },
    };
  }
  return {
    engine, broadcasts, scheduled, recovered, asked, connect,
    update(tab) {
      tabs.set(tab.id, tab);
      return chrome.tabs.onUpdated.run(tab.id, { status: tab.status }, tab);
    },
    report(id, playing) {
      const sender = { tab: { id, url: tabs.get(id)?.url } };
      return new Promise(resolve => chrome.runtime.onMessage.run({ type: 'ox-playing', playing }, sender, resolve));
    },
    status() {
      return new Promise(resolve => chrome.runtime.onMessage.run({ type: 'ox-status' }, {}, resolve));
    },
  };
}

const tab = (id, path, status = 'complete', live = false) => ({ id, url: `https://lichess.org${path}`, status, live });
const analysis = tab(1, '/analysis');
const tv = tab(2, '/tv', 'complete', true);
const game = tab(3, '/a1B2c3D4/black', 'complete', true);

const fresh = worker([analysis, { ...tv, status: 'loading', live: false }]);
assert.equal((await fresh.status()).paused, true, 'startup locks for TV before the layout is available');
assert.ok(fresh.engine.every(Boolean), 'startup keepalive never unpauses the engine before the scan');

const session = worker([analysis]);
assert.equal((await session.status()).paused, false, 'analysis alone is unlocked');
await session.update({ ...tv, status: 'loading' });
assert.equal((await session.report(tv.id, false)).paused, true, 'a late quiet report cannot unlock during navigation');
await session.update(tv);
await session.update({ ...game, status: 'loading' });
const beforeHandoff = session.broadcasts.length;
await session.update(tab(tv.id, '/analysis', 'loading'));
await session.update(tab(tv.id, '/analysis'));
assert.equal((await session.report(analysis.id, false)).paused, true, 'the second live page keeps the lock during handoff');
assert.equal(session.broadcasts.length, beforeHandoff, 'no resume is broadcast between games');
await session.update(game);
await session.report(game.id, false);
assert.equal((await session.status()).paused, false, 'the last finished game releases the lock');
assert.equal(session.engine.at(-1), false, 'the engine resumes too');

const leaving = worker([analysis, tv]);
await leaving.status();
const exit = { id: tv.id, url: tv.url, pendingUrl: 'https://example.org/', status: 'loading', live: true };
await leaving.update(exit);
assert.equal((await leaving.status()).paused, true, 'leaving for another site does not unlock while TV is still displayed');
assert.equal((await leaving.report(tv.id, false)).paused, true, 'an old page cannot clear the lock during the navigation');
await leaving.update({ id: tv.id, url: exit.pendingUrl, status: 'complete', live: false });
assert.equal((await leaving.status()).paused, false, 'the completed navigation releases the lock');

// Pages whose address only has the shape of a game's must not lock while they
// load (Puzzles, Practice…); the addresses games really have must.
for (const path of ['/training', '/practice', '/streamer', '/analysis', '/study/a1B2c3D4']) {
  const quiet = worker([analysis]);
  await quiet.status();
  await quiet.update(tab(5, path, 'loading'));
  assert.equal((await quiet.status()).paused, false, `${path} loading is not a game`);
  assert.equal(quiet.broadcasts.length, 0, `${path} loading pauses no tab`);
}
for (const path of ['/a1B2c3D4', '/game/a1B2c3D4', '/game/a1B2c3D4wxyz', '/game/a1B2c3D4/black', '/tv/blitz', '/@/someone/tv']) {
  const loading = worker([analysis]);
  await loading.status();
  await loading.update(tab(5, path, 'loading'));
  assert.equal((await loading.status()).paused, true, `${path} counts as a game while it loads`);
}

const updating = worker([analysis], { loadedBuild: 1, build: 2 });
const statuses = await Promise.all([updating.status(), updating.status()]);
assert.ok(statuses.every(status => status.paused && status.reloading), 'every initializing page waits for a pending reload');
assert.equal(updating.scheduled.length, 1, 'concurrent checks schedule one reload');
assert.equal((await updating.report(analysis.id, false)).paused, true, 'a quiet report cannot resume an initializing page before reload');

const retrying = worker([analysis], { rejectFirstPause: true });
await retrying.status();
await retrying.update({ ...tv, status: 'loading' });
assert.equal(retrying.broadcasts.at(-1)[1], true, 'panels pause even if the engine rejects the first update');
assert.equal(retrying.scheduled.filter(Boolean).length, 1, 'a failed pause has a prompt retry');
await retrying.scheduled.find(Boolean)();
assert.deepEqual(retrying.engine.slice(-2), [true, true], 'the retry repeats the pause');

const departed = worker([analysis], { rejectFirstPause: true });
await departed.status();
await departed.update({ ...tv, status: 'loading' });
const lateRetry = departed.scheduled.find(Boolean);
await departed.update(tab(tv.id, '/training'));
await lateRetry();
assert.equal(departed.engine.at(-1), false, 'a late retry reads the current lock after leaving TV');

const forecast = tab(game.id, '/game/a1B2c3D4/black/analysis');
const forecastSession = worker([analysis, game]);
assert.equal((await forecastSession.status()).paused, true);
await forecastSession.update({ ...forecast, status: 'loading' });
await forecastSession.update(forecast);
assert.equal((await forecastSession.report(game.id, false)).paused, true,
  'a forecast that looks like an ordinary analysis board cannot unlock an ongoing game');
assert.ok(forecastSession.engine.every(Boolean), 'the engine stays paused when moving to the forecast');
await forecastSession.update(tab(game.id, '/game/a1B2c3D4/black'));
assert.equal((await forecastSession.status()).paused, false, 'a redirect to the finished review releases the forecast lock');

const restoredForecast = worker([analysis, forecast]);
assert.equal((await restoredForecast.status()).paused, true, 'a restored forecast keeps the engine locked before content reports');
assert.ok(restoredForecast.engine.every(Boolean));

const retryResume = worker([analysis, game], { rejectFirstResume: true });
await retryResume.status();
await retryResume.update(tab(game.id, '/training'));
assert.equal((await retryResume.report(analysis.id, false)).paused, false, 'panels are available during an engine retry');
assert.deepEqual(retryResume.recovered, [], 'tabs have not heard that Stockfish resumed before it does');
await retryResume.scheduled.find(Boolean)();
assert.deepEqual(retryResume.engine.slice(-2), [false, false]);
assert.ok(retryResume.recovered.includes(analysis.id), 'the successful retry tells analysis to search again');

// --- Lichess's analysis answered on this computer (engine-relay.js's port) ----
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve)); };
const streamOf = (chunks, { hold = false } = {}) => {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk)); if (!hold) c.close(); } });
  return { response: { ok: true, status: 200, body }, controller };
};
const WORK = { sessionId: 's', moves: [], movetime: 8000 };
{
  const lines = ['{"time":1,"depth":1,"nodes":1,"pvs":[]}\n', '{"time":2,"depth":2,"nodes":2,"pvs":[],"bestmove":"e2e4"}\n'];
  const here = worker([analysis], { analyse: async () => streamOf(lines).response });
  await here.status();
  const page = here.connect(analysis.id);
  page.send({ engineId: 'eei_x', work: WORK });
  await settle();
  assert.deepEqual(here.asked[0].body, { engineId: 'eei_x', work: WORK }, 'the app is asked with the page\'s work');
  assert.equal(page.got[0].kind, 'start');
  assert.equal(page.got.filter(m => m.kind === 'chunk').map(m => m.text).join(''), lines.join(''), 'the app\'s lines reach the page');
  assert.equal(page.got.at(-1).kind, 'end');
}
{
  // During a game: the empty answer, and the app is not even asked.
  const locked = worker([analysis, tv], { analyse: async () => streamOf(['x']).response });
  await locked.status();
  const page = locked.connect(analysis.id);
  page.send({ engineId: 'eei_x', work: WORK });
  await settle();
  assert.equal(locked.asked.length, 0, 'the app is not asked during a game');
  assert.deepEqual(page.got.map(m => m.kind), ['start', 'chunk', 'end']);
  assert.deepEqual(JSON.parse(page.got[1].text), { time: 0, depth: 0, nodes: 0, pvs: [], bestmove: '(none)' });
}
for (const [label, analyse] of [['app down', undefined], ['not the app\'s engine', async () => ({ ok: false, status: 404, body: null })]]) {
  const down = worker([analysis], { analyse });
  await down.status();
  const page = down.connect(analysis.id);
  page.send({ engineId: 'eei_x', work: WORK });
  await settle();
  assert.deepEqual(page.got.map(m => m.kind), ['unavailable'], `${label}: the page asks Lichess's service instead`);
}
{
  // Lichess cancels (you moved on): the port closes, the app's request is aborted.
  const held = streamOf(['{"a":1}\n'], { hold: true });
  const here = worker([analysis], { analyse: async () => held.response });
  await here.status();
  const page = here.connect(analysis.id);
  page.send({ engineId: 'eei_x', work: WORK });
  await settle();
  assert.deepEqual(page.got.map(m => m.kind), ['start', 'chunk']);
  page.close();
  await settle();
  assert.equal(here.asked[0].signal.aborted, true, 'the app\'s request is aborted, which stops Stockfish');
}
{
  const here = worker([analysis], { analyse: async () => streamOf([]).response });
  const stranger = here.connect(99, 'https://example.org/');
  assert.equal(stranger.port.closed, true, 'only Lichess pages may ask');
}

console.log('Live-game lock checks passed.');
