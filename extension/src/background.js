// Background service worker: the only part that talks to the openings app,
// and the keeper of the live-game lock across every Lichess tab.
importScripts('backend-client.js', 'anchors.js'); // anchors: the live-game selectors
const ext = chrome;
const A = globalThis.OX.anchors;
const BACKEND = 'http://127.0.0.1:8001';
const client = globalThis.OX_createBackendClient(`${BACKEND}/api`);
const LICHESS_TABS = { url: 'https://lichess.org/*' };

// The toolbar opens extension-owned account and backup settings. Credentials
// are entered there, never into a Lichess page or content script.
ext.action.onClicked.addListener(() => ext.runtime.openOptionsPage());

// --- live-game lock -------------------------------------------------------
// A tab showing a game in progress pauses every feature in every tab, so
// nothing from the app can help during a game. Kept in session storage because
// Chrome stops this service worker between events.
async function playingTabs() {
  const { playingTabs = [] } = await ext.storage.session.get('playingTabs');
  return new Set(playingTabs);
}

// One change at a time: two tabs reporting at once must not overwrite each
// other's entry (a lost entry would unlock the features during a game).
let lockQueue = Promise.resolve();
function setTabPlaying(tabId, playing) {
  const change = lockQueue.then(async () => {
    const tabs = await playingTabs();
    if (tabs.has(tabId) === playing) return tabs.size > 0;
    const before = tabs.size > 0;
    if (playing) tabs.add(tabId); else tabs.delete(tabId);
    await ext.storage.session.set({ playingTabs: [...tabs] });
    const paused = tabs.size > 0;
    if (paused !== before) {
      await broadcastPaused(paused);
      tellEngine(paused);
    }
    await refreshBadge();
    return paused;
  });
  lockQueue = change.catch(() => {});
  return change;
}

// Your Stockfish takes no work from Lichess while a game is on, so no Lichess
// tab can use it then (backend/lichess_engine_provider.py). Said on every
// change and again with every keepalive, so an app (re)started mid-game hears it.
function tellEngine(paused) {
  return client.api('PUT', '/lichess-engine/paused', { paused }).catch(() => {});
}

// Session storage is emptied when the extension is updated or Chrome restarts,
// and Lichess tabs already open don't report again until their new copy runs:
// until then a game in one of them must still count. So the first time the
// lock is asked about after that, every Lichess tab is looked at directly.
function looksLikeGame(url) {
  try {
    const { host, pathname } = new URL(url);
    return host === 'lichess.org' && /^\/(?:game\/)?[A-Za-z0-9]{8}(?:[A-Za-z0-9]{4})?(?:\/(?:white|black))?\/?$/.test(pathname);
  } catch { return false; }
}
async function tabIsLive(tab) {
  if (tab.discarded) return false; // unloaded by Chrome: nothing is shown in it
  try {
    const [{ result }] = await ext.scripting.executeScript({
      target: { tabId: tab.id },
      func: (round, finished) => !!document.querySelector(round) && !document.querySelector(finished),
      args: [A.roundPage.selector, A.roundFinished.selector],
    });
    return result === true;
  } catch {
    // Not readable right now (loading, an error page): a game's address counts as live.
    return looksLikeGame(tab.url);
  }
}
let seeding = null;
function seedLock() {
  seeding = seeding || (async () => {
    const { lockSeeded } = await ext.storage.session.get('lockSeeded');
    if (lockSeeded) return;
    const tabs = await ext.tabs.query(LICHESS_TABS);
    const live = await Promise.all(tabs.map(tabIsLive));
    await Promise.all(tabs.filter((tab, i) => live[i]).map(tab => setTabPlaying(tab.id, true)));
    await ext.storage.session.set({ lockSeeded: true });
  })().catch(() => {}); // never in the way of an answer: the tabs' own reports still come
  return seeding;
}

async function broadcastPaused(paused) {
  const tabs = await ext.tabs.query(LICHESS_TABS);
  await Promise.all(tabs.map(tab =>
    ext.tabs.sendMessage(tab.id, { type: 'ox-paused', paused }).catch(() => {})));
}

ext.tabs.onRemoved.addListener(tabId => {
  setTabPlaying(tabId, false);
  stopIfUnwanted();
});
// A playing tab that leaves Lichess is no longer a live game. One that loads
// another Lichess page keeps the lock until that page's content script says
// otherwise: the next page may be a game too (a rematch, "New opponent"), and
// unlocking in between showed everything in the other tabs for a moment.
ext.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.status === 'loading' && !tab.url?.startsWith('https://lichess.org/')) setTabPlaying(tabId, false);
  // A Lichess page our script can't run in (an error page) never reports.
  if (change.status === 'complete' && (await playingTabs()).has(tabId)) setTabPlaying(tabId, await tabIsLive(tab));
});

// --- toolbar badge ---------------------------------------------------------
async function refreshBadge() {
  const paused = (await playingTabs()).size > 0;
  const { brokenFeatures = [] } = await ext.storage.local.get('brokenFeatures');
  let text = '';
  let colour = '#888';
  let title = 'Openings for Lichess';
  if (paused) {
    text = 'live';
    title += ' — paused while a game is in progress';
  } else if (brokenFeatures.length) {
    text = '!';
    colour = '#c33';
    title += ` — not showing because Lichess changed: ${brokenFeatures.join(', ')}`;
  }
  await ext.action.setBadgeText({ text });
  await ext.action.setBadgeBackgroundColor({ color: colour });
  await ext.action.setTitle({ title });
}

// Latest report per page kind, so the badge reflects every kind of page.
async function rememberHealth(report) {
  const { healthByKind = {} } = await ext.storage.local.get('healthByKind');
  healthByKind[report.page_kind] = Object.entries(report.features)
    .filter(([, f]) => f.status === 'missing' || f.status === 'hidden' || f.status === 'error')
    .map(([, f]) => f.name);
  const brokenFeatures = [...new Set(Object.values(healthByKind).flat())];
  await ext.storage.local.set({ healthByKind, brokenFeatures });
  await refreshBadge();
}

// --- starting the app ------------------------------------------------------
// The native helper (extension/native, installed once with install.sh) starts
// ./start.sh when Lichess is opened and the app isn't running.
const NATIVE_HOST = 'openings_app';
let autostart = { state: null, at: 0 }; // state: starting | running | unavailable

async function appRunning() {
  try {
    const res = await fetch(`${BACKEND}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function startApp() {
  if (Date.now() - autostart.at < 20_000) return autostart.state;
  autostart = { state: 'starting', at: Date.now() };
  try {
    const reply = await ext.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'start' });
    autostart.state = reply?.state === 'running' || reply?.state === 'starting' ? reply.state : 'unavailable';
  } catch {
    autostart.state = 'unavailable'; // helper not installed: say how to start it by hand
  }
  return autostart.state;
}

// --- keeping the app running only while it is wanted -------------------------
// Closing the last tab asks the helper to stop the app at once. If Chrome quits
// or crashes before that event runs, the app stops itself after two minutes
// without contact (backend/idle_exit.py). While a Lichess tab or settings is
// open, an alarm says "still here" every half minute. Alarms wake this service
// worker however long the tabs sit in the background, which timers in the
// pages would not.
const KEEPALIVE_ALARM = 'ox-keepalive';
const KEEPALIVE_MINUTES = 0.5;

// Stops the app once nothing of ours is open any more. Only when this browser
// was using it (the keepalive alarm is set): otherwise every tab closed
// anywhere in Chrome started the helper again, a Python process each time,
// long after the app had stopped.
let stopping = null;
function stopIfUnwanted() {
  stopping = stopping || (async () => {
    if (!(await ext.alarms.get(KEEPALIVE_ALARM)) || (await wanted())) return;
    await ext.alarms.clear(KEEPALIVE_ALARM);
    // The helper refuses to stop a service started by hand. On Chrome quit or
    // crash this may not run; the service's idle watchdog covers that.
    try { await ext.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'stop' }); } catch {}
    // Opening Lichess again must start it at once, not wait out startApp's
    // 20-second guard against starting twice.
    autostart = { state: null, at: 0 };
  })().finally(() => { stopping = null; });
  return stopping;
}

async function wanted() {
  if ((await ext.tabs.query(LICHESS_TABS)).length > 0) return true;
  // The settings page (accounts, syncing, checking games) uses the app too.
  try {
    const pages = await ext.runtime.getContexts({ contextTypes: ['TAB'] });
    return pages.some(page => page.documentUrl?.startsWith(ext.runtime.getURL('settings.html')));
  } catch {
    return false;
  }
}

let lastKeepalive = 0;
async function keepAlive() {
  if (!(await wanted())) {
    // Nothing of ours is open (a Lichess tab went to another site): stop it.
    await stopIfUnwanted();
    return false;
  }
  if (!(await ext.alarms.get(KEEPALIVE_ALARM))) {
    ext.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_MINUTES });
  }
  // Every request to the app counts too, so a page loading (a dozen
  // requests) needs no extra call each time.
  if (Date.now() - lastKeepalive < 10_000) return true;
  lastKeepalive = Date.now();
  // Not answered means the app is down: the next real request starts it.
  fetch(`${BACKEND}/api/keepalive`, { method: 'POST' }).catch(() => {});
  tellEngine((await playingTabs()).size > 0);
  return true;
}

ext.alarms.onAlarm.addListener(alarm => { if (alarm.name === KEEPALIVE_ALARM) keepAlive(); });
// Chrome may drop alarms when it restarts; tabs it restores bring them back.
ext.runtime.onStartup.addListener(() => { keepAlive(); });

// --- picking up code changes ---------------------------------------------------
// The app reports when the extension's files last changed. If that is newer
// than what this copy was loaded from, reload; the next Lichess page load then
// runs the new code.
async function reloadIfUpdated() {
  let build;
  try { build = (await client.api('GET', '/extension/build')).data?.build; } catch { return false; }
  if (!build) return false;
  const { loadedBuild } = await ext.storage.local.get('loadedBuild');
  if (!loadedBuild) { await ext.storage.local.set({ loadedBuild: build }); return false; }
  if (build <= loadedBuild) return false;
  await ext.storage.local.set({ loadedBuild: build });
  setTimeout(() => ext.runtime.reload(), 100);
  return true;
}
// After an install or update, open Lichess tabs still run the old copy (now cut
// off). Put the new one in, so no page reload is needed.
ext.runtime.onInstalled.addListener(async () => {
  // What an older copy found broken says nothing about this one.
  await ext.storage.local.remove(['loadedBuild', 'healthByKind', 'brokenFeatures']);
  await refreshBadge();
  const scripts = ext.runtime.getManifest().content_scripts;
  const main = scripts.find(c => c.world === 'MAIN');
  const isolated = scripts.find(c => c.js.includes('src/content.js'));
  const css = scripts.flatMap(c => c.css || []);
  for (const tab of await ext.tabs.query(LICHESS_TABS)) {
    try {
      if (css.length) await ext.scripting.insertCSS({ target: { tabId: tab.id }, files: css });
      if (main) await ext.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: main.js });
      await ext.scripting.executeScript({ target: { tabId: tab.id }, files: isolated.js });
    } catch { /* tab still loading or not scriptable: it gets the new copy when it loads */ }
  }
});

// --- messages from content scripts -----------------------------------------
ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const run = async () => {
    switch (message?.type) {
      case 'ox-open-settings':
        await ext.runtime.openOptionsPage();
        return { ok: true };
      case 'ox-api':
        try {
          const answer = await client.api(message.method, message.path, message.body);
          keepAlive();
          return answer;
        } catch (error) {
          const state = await startApp();
          return { ok: false, status: 0, data: null, offline: true, autostart: state, error: String(error) };
        }
      case 'ox-status': {
        await seedLock();
        keepAlive();
        // Fail-closed: while this copy is about to be replaced, stay paused.
        if (await reloadIfUpdated()) return { paused: true, reloading: true };
        // Opening a Lichess page starts the app if it isn't running.
        const running = await appRunning();
        if (!running) await startApp();
        return { paused: (await playingTabs()).size > 0, autostart: running ? 'running' : autostart.state };
      }
      case 'ox-playing':
        await seedLock();
        return { paused: tabId == null ? false : await setTabPlaying(tabId, message.playing) };
      case 'ox-health':
        await rememberHealth(message.report);
        client.api('POST', '/extension/health', message.report).catch(() => {});
        return { ok: true };
      default:
        return null;
    }
  };
  // Always answer: an unanswered message leaves the page waiting for nothing.
  run().catch(error => ({ ok: false, status: 0, data: null, error: String(error) })).then(sendResponse);
  return true; // answer asynchronously
});

refreshBadge();
