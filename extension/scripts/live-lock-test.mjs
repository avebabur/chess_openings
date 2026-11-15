import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function worker(initialTabs = [], { loadedBuild, build } = {}) {
  const tabs = new Map(initialTabs.map(tab => [tab.id, tab]));
  const engine = [];
  const broadcasts = [];
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
    runtime: { onStartup: event(), onInstalled: event(), onMessage: event() },
    scripting: { async executeScript({ target }) { return [{ result: tabs.get(target.tabId)?.live }]; } },
    tabs: {
      onRemoved: event(), onReplaced: event(), onUpdated: event(),
      async get(id) { return tabs.get(id); },
      async query() { return [...tabs.values()].filter(tab => tab.url.startsWith('https://lichess.org/')); },
      async sendMessage(id, message) { broadcasts.push([id, message.paused]); },
    },
  };
  const context = {
    AbortSignal, URL, chrome,
    importScripts() {},
    OX_createBackendClient: () => ({ async api() { return { ok: true, data: { build } }; } }),
    setTimeout(callback) { scheduled.push(callback); },
    async fetch(url, options) {
      if (url.endsWith('/paused')) engine.push(JSON.parse(options.body).paused);
      return { ok: true };
    },
  };
  // The real anchors.js (the worker imports it): the live-game selectors and
  // the list of pages whose address only looks like a game's.
  const source = file => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  runInNewContext(`${source('anchors.js')}\n${source('background.js')}`, context);
  return {
    engine, broadcasts, scheduled,
    update(tab) {
      tabs.set(tab.id, tab);
      return chrome.tabs.onUpdated.run(tab.id, { status: tab.status }, tab);
    },
    report(id, playing) {
      return new Promise(resolve => chrome.runtime.onMessage.run({ type: 'ox-playing', playing }, { tab: { id } }, resolve));
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

console.log('Live-game lock checks passed.');
