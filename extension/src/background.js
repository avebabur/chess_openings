// Background service worker: the only part that talks to the openings app,
// and the keeper of the live-game lock across every Lichess tab.
importScripts('backend-client.js');
const ext = chrome;
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
    if (paused !== before) await broadcastPaused(paused);
    await refreshBadge();
    return paused;
  });
  lockQueue = change.catch(() => {});
  return change;
}

async function broadcastPaused(paused) {
  const tabs = await ext.tabs.query(LICHESS_TABS);
  await Promise.all(tabs.map(tab =>
    ext.tabs.sendMessage(tab.id, { type: 'ox-paused', paused }).catch(() => {})));
}

ext.tabs.onRemoved.addListener(tabId => { setTabPlaying(tabId, false); });
// A playing tab that starts loading anything else is no longer a live game;
// if it loads another game page, its content script reports it again.
ext.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') setTabPlaying(tabId, false);
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
  ext.storage.session.set({ appInUse: true });
  autostart = { state: 'starting', at: Date.now() };
  try {
    const reply = await ext.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'start' });
    autostart.state = reply?.state === 'running' || reply?.state === 'starting' ? reply.state : 'unavailable';
  } catch {
    autostart.state = 'unavailable'; // helper not installed: say how to start it by hand
  }
  return autostart.state;
}

// --- stopping the app when Lichess is closed ------------------------------------
// Two minutes after the last Lichess tab closes, the helper asks launchd to
// stop the app it started (Stockfish included). Opening Lichess again within
// that time cancels it. `appInUse` (set when a Lichess page or the settings
// page used the app) keeps this to once per use: without it every tab closed
// or loaded anywhere in Chrome pushed the stop back another two minutes, and
// asked the helper again and again after the app had stopped.
const STOP_ALARM = 'ox-stop-app';
const STOP_AFTER_MINUTES = 2;

async function lichessTabsOpen() {
  return (await ext.tabs.query(LICHESS_TABS)).length > 0;
}

async function stopLaterIfLichessClosed() {
  const { appInUse } = await ext.storage.session.get('appInUse');
  if (!appInUse || (await ext.alarms.get(STOP_ALARM)) || (await lichessTabsOpen())) return;
  ext.alarms.create(STOP_ALARM, { delayInMinutes: STOP_AFTER_MINUTES });
}

ext.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== STOP_ALARM || (await lichessTabsOpen())) return;
  await ext.storage.session.set({ appInUse: false });
  try { await ext.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'stop' }); } catch { /* helper not installed */ }
  autostart = { state: null, at: 0 };
});
ext.tabs.onRemoved.addListener(() => { stopLaterIfLichessClosed(); });
ext.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'complete') stopLaterIfLichessClosed(); });

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
          ext.storage.session.set({ appInUse: true });
          return answer;
        } catch (error) {
          const state = await startApp();
          return { ok: false, status: 0, data: null, offline: true, autostart: state, error: String(error) };
        }
      case 'ox-status': {
        ext.alarms.clear(STOP_ALARM);
        // Fail-closed: while this copy is about to be replaced, stay paused.
        if (await reloadIfUpdated()) return { paused: true, reloading: true };
        // Opening a Lichess page starts the app if it isn't running.
        const running = await appRunning();
        if (!running) await startApp();
        return { paused: (await playingTabs()).size > 0, autostart: running ? 'running' : autostart.state };
      }
      case 'ox-playing':
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
