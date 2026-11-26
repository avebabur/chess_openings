// Background service worker: the only part that talks to the openings app.
importScripts('backend-client.js');
const ext = chrome;
const BACKEND = 'http://127.0.0.1:8001';
const client = globalThis.OX_createBackendClient(`${BACKEND}/api`);
const LICHESS_TABS = { url: 'https://lichess.org/*' };

// The toolbar opens extension-owned account and backup settings. Credentials
// are entered there, never into a Lichess page or content script.
ext.action.onClicked.addListener(() => ext.runtime.openOptionsPage());

// The app was seen down and now answers: Lichess's engine bar in open tabs was
// left showing an error, so they are asked to search again.
// null: not known yet (this service worker just started), which is not "down".
let appUp = null;
function noteApp(up) {
  if (up && appUp === false) broadcast({ type: 'ox-engine-resumed' }).catch(() => {});
  appUp = up;
}

async function broadcast(message, exceptTab) {
  const tabs = await ext.tabs.query(LICHESS_TABS);
  await Promise.all(tabs.filter(tab => tab.id !== exceptTab).map(tab =>
    ext.tabs.sendMessage(tab.id, message).catch(() => {})));
}

ext.tabs.onRemoved.addListener(() => { stopIfUnwanted(); });

// --- toolbar badge ---------------------------------------------------------
async function refreshBadge() {
  const { brokenFeatures = [] } = await ext.storage.local.get('brokenFeatures');
  const broken = brokenFeatures.length > 0;
  await ext.action.setBadgeText({ text: broken ? '!' : '' });
  await ext.action.setBadgeBackgroundColor({ color: '#c33' });
  await ext.action.setTitle({ title: 'Openings for Lichess'
    + (broken ? ` — not showing because Lichess changed: ${brokenFeatures.join(', ')}` : '') });
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
  // Not answered means the app is down (it crashed, or was stopped by hand):
  // start it again, so Lichess's engine bar and the boxes come back by
  // themselves even on a page nobody touches.
  fetch(`${BACKEND}/api/keepalive`, { method: 'POST' })
    .then(res => noteApp(res.ok))
    .catch(() => { noteApp(false); startApp(); });
  return true;
}

ext.alarms.onAlarm.addListener(alarm => { if (alarm.name === KEEPALIVE_ALARM) keepAlive(); });
// Chrome may drop alarms when it restarts; tabs it restores bring them back.
ext.runtime.onStartup.addListener(() => { keepAlive(); });

// --- picking up code changes ---------------------------------------------------
// The app reports when the extension's files last changed. If that is newer
// than what this copy was loaded from, reload; the next Lichess page load then
// runs the new code.
let reloadPending = false;
async function reloadIfUpdated() {
  if (reloadPending) return true;
  let build;
  try { build = (await client.api('GET', '/extension/build')).data?.build; } catch { return false; }
  if (reloadPending) return true;
  if (!build) return false;
  const { loadedBuild } = await ext.storage.local.get('loadedBuild');
  if (reloadPending) return true;
  if (!loadedBuild) { await ext.storage.local.set({ loadedBuild: build }); return false; }
  if (build <= loadedBuild) return false;
  reloadPending = true;
  try {
    await ext.storage.local.set({ loadedBuild: build });
  } finally {
    setTimeout(() => ext.runtime.reload(), 100);
  }
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
  const relay = scripts.find(c => c.js.includes('src/engine-relay.js'));
  const isolated = scripts.find(c => c.js.includes('src/content.js'));
  const css = scripts.flatMap(c => c.css || []);
  for (const tab of await ext.tabs.query(LICHESS_TABS)) {
    try {
      if (css.length) await ext.scripting.insertCSS({ target: { tabId: tab.id }, files: css });
      if (relay) await ext.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/engine-relay.js'] });
      if (main) await ext.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: main.js });
      await ext.scripting.executeScript({ target: { tabId: tab.id }, files: isolated.js });
    } catch { /* tab still loading or not scriptable: it gets the new copy when it loads */ }
  }
});

// --- Lichess's analysis, answered on this computer ---------------------------
// The page's analysis requests come here (page-bridge.js, then engine-relay.js,
// over a port) and go to the app, not round the world through Lichess's engine
// service, whose per-address limit stepping through a game kept running into.
// The app's lines go back as they come; closing the port (Lichess cancelled:
// you moved on) aborts the request, and the app stops Stockfish. "unavailable"
// (the app is down, or the engine is not the app's) sends the page to
// Lichess's engine service as before.
const LOCAL_ANALYSE = `${BACKEND}/api/lichess-engine/analyse`;
const LOCAL_ANSWER_MS = 4000; // the app answers at once; the lines take their time

async function analyseHere(port, ask) {
  const controller = new AbortController();
  let open = true;
  port.onDisconnect.addListener(() => { open = false; controller.abort(); });
  const post = message => {
    if (!open) return;
    try { port.postMessage(message); } catch { open = false; controller.abort(); }
  };
  let response;
  const timer = setTimeout(() => controller.abort(), LOCAL_ANSWER_MS);
  try {
    response = await fetch(LOCAL_ANALYSE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engineId: ask?.engineId, work: ask?.work }),
      signal: controller.signal,
    });
  } catch {
    if (open) noteApp(false);
    post({ kind: 'unavailable' });
    return;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    post({ kind: 'unavailable' });
    return;
  }
  noteApp(true);
  keepAlive();
  post({ kind: 'start' });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) post({ kind: 'chunk', text });
      if (!open) return;
    }
    post({ kind: 'end' });
  } catch {
    post({ kind: 'error' }); // the app stopped mid-search
  } finally {
    if (!open) reader.cancel().catch(() => {});
  }
}

ext.runtime.onConnect.addListener(port => {
  if (port.name !== 'ox-engine') return;
  const url = port.sender?.url || port.sender?.tab?.url || '';
  if (!port.sender?.tab || !url.startsWith('https://lichess.org/')) { port.disconnect(); return; }
  const first = ask => {
    port.onMessage.removeListener(first);
    analyseHere(port, ask).catch(() => {
      try { port.postMessage({ kind: 'error' }); } catch { /* gone */ }
    });
  };
  port.onMessage.addListener(first);
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
          if (answer.ok && ['POST', 'PATCH', 'DELETE'].includes(message.method)
            && /^\/repertoire\/tree\/branches(?:\/\d+)?$/.test(message.path)) {
            broadcast({ type: 'ox-repertoire-changed' }, tabId).catch(() => {});
          }
          noteApp(true);
          keepAlive();
          return answer;
        } catch (error) {
          noteApp(false);
          const state = await startApp();
          return { ok: false, status: 0, data: null, offline: true, autostart: state, error: String(error) };
        }
      case 'ox-status': {
        keepAlive();
        // This copy is about to be replaced: the page waits for the new one.
        if (await reloadIfUpdated()) return { reloading: true };
        // Opening a Lichess page starts the app if it isn't running.
        const running = await appRunning();
        noteApp(running);
        if (!running) await startApp();
        return { autostart: running ? 'running' : autostart.state };
      }
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
