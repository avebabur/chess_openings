// The background worker's part of "new games into a Lichess study": it
// publishes the app's finished analyses from a Lichess tab (Lichess's own
// Publish request, which needs the page's login), never during a game, and
// asks the app to fetch new games when a game ends.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function worker({ tabs: initialTabs, ready = [], pageUser = 'avebabur', publishStatus = 200 }) {
  const tabs = new Map(initialTabs.map(tab => [tab.id, tab]));
  const calls = [];       // app requests: [method, path, body]
  const published = [];   // what the page posted to /analysis/publish
  const scheduled = [];
  const event = () => ({ addListener(listener) { this.run = listener; } });
  const storage = (data = {}) => ({
    async get(key) { return { [key]: data[key] }; }, async set(value) { Object.assign(data, value); },
    async remove() {},
  });
  let queue = [...ready];
  const chrome = {
    storage: { session: storage(), local: storage() },
    alarms: { onAlarm: event(), async get() { return true; }, create() {}, async clear() {} },
    action: { onClicked: event(), async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
    runtime: { onStartup: event(), onInstalled: event(), onMessage: event(), onConnect: event(), getManifest: () => ({}) },
    scripting: {
      async executeScript({ target, world, func, args }) {
        if (world !== 'MAIN') return [{ result: tabs.get(target.tabId)?.live }];
        // The page: its signed-in user and its own fetch.
        context.document = { body: { dataset: pageUser ? { user: pageUser } : {} } };
        return [{ result: await func(...args) }];
      },
    },
    tabs: {
      onRemoved: event(), onReplaced: event(), onUpdated: event(),
      async get(id) { return tabs.get(id); },
      async query() { return [...tabs.values()].filter(tab => tab.url.startsWith('https://lichess.org/')); },
      async sendMessage() {},
    },
  };
  const context = {
    AbortSignal, AbortController, URL, chrome, TextDecoder, String, JSON, Array,
    importScripts() {},
    OX_createBackendClient: () => ({
      async api(method, path, body) {
        calls.push([method, path, body]);
        if (path === '/study-analysis/ready') return { ok: true, data: queue.splice(0, 1) };
        return { ok: true, data: {} };
      },
    }),
    setTimeout(callback) { return scheduled.push(callback) - 1; },
    clearTimeout(id) { scheduled[id] = null; },
    async fetch(url, options) {
      if (url === '/analysis/publish') {
        published.push(JSON.parse(options.body));
        return { ok: publishStatus < 300, status: publishStatus, async text() { return 'refused'; } };
      }
      return { ok: true, async json() { return {}; } };
    },
  };
  const source = file => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  runInNewContext(`${source('anchors.js')}\n${source('background.js')}`, context);
  return {
    calls, published, scheduled, context,
    publish: () => context.publishReady(),
    report(id, playing) {
      const sender = { tab: { id, url: tabs.get(id)?.url } };
      return new Promise(resolve => chrome.runtime.onMessage.run({ type: 'ox-playing', playing }, sender, resolve));
    },
    update(tab) {
      tabs.set(tab.id, tab);
      return chrome.tabs.onUpdated.run(tab.id, { status: tab.status }, tab);
    },
  };
}

const tab = (id, path, live = false) => ({ id, url: `https://lichess.org${path}`, status: 'complete', live });
const item = (gameId, owner = 'avebabur') => ({
  game_id: gameId, study_id: 'study123', chapter_id: 'chap1234', user_id: owner,
  document: { id: 'chap1234', studyId: 'study123', infos: [], engine: { userId: owner } },
});
const paths = calls => calls.map(([method, path]) => `${method} ${path}`);

let failures = 0;
async function test(name, run) {
  try { await run(); console.log(`ok    ${name}`); }
  catch (error) { failures++; console.log(`FAIL  ${name}\n${error.stack}`); }
}

await test('a finished analysis is published from a signed-in tab and reported', async () => {
  const w = worker({ tabs: [tab(1, '/study/abc')], ready: [item(7)] });
  await w.publish();
  assert.equal(w.published.length, 1);
  assert.equal(w.published[0].id, 'chap1234');
  assert.ok(paths(w.calls).includes('POST /study-analysis/7/published'));
});

await test('a tab signed in as someone else, or not at all, publishes nothing and reports nothing', async () => {
  for (const pageUser of ['someoneelse', null]) {
    const w = worker({ tabs: [tab(1, '/')], ready: [item(7)], pageUser });
    await w.publish();
    assert.equal(w.published.length, 0);
    assert.ok(!paths(w.calls).some(p => p.includes('/study-analysis/7/')), pageUser);
  }
});

await test("Lichess's refusal is reported with its status", async () => {
  const w = worker({ tabs: [tab(1, '/')], ready: [item(7)], publishStatus: 423 });
  await w.publish();
  const failed = w.calls.find(([, path]) => path === '/study-analysis/7/publish-failed');
  assert.equal(failed?.[2].status, 423);
  assert.ok(!paths(w.calls).includes('POST /study-analysis/7/published'));
});

await test('nothing is published, or even asked for, during a game', async () => {
  const w = worker({ tabs: [tab(1, '/'), tab(2, '/a1B2c3D4', true)], ready: [item(7)] });
  await w.report(2, true);
  await w.publish();
  assert.equal(w.published.length, 0);
  assert.ok(!paths(w.calls).includes('GET /study-analysis/ready'));
});

await test('the end of a game asks the app to fetch the new games', async () => {
  const w = worker({ tabs: [tab(1, '/'), tab(2, '/a1B2c3D4', true)] });
  await w.report(2, true);
  assert.ok(!paths(w.calls).includes('POST /study-analysis/game-ended'));
  await w.report(2, false);
  for (const run of w.scheduled.splice(0)) if (run) await run();
  assert.ok(paths(w.calls).includes('POST /study-analysis/game-ended'));
});

if (failures) { console.log(`FAIL  ${failures} study publishing test(s)`); process.exit(1); }
console.log('All study publishing tests passed');
