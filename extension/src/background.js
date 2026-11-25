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
      if (paused) await Promise.all([tellEngine(true), broadcastPaused(true)]);
      else {
        // Resume the engine before tabs start asking it for new analysis.
        await tellEngine(false);
        await broadcastPaused(false);
        gameEnded();
      }
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
let engineRetry = null;
let engineResumePending = false;
async function tellEngine(paused) {
  if (engineRetry !== null) clearTimeout(engineRetry);
  engineRetry = null;
  try {
    const response = await fetch(`${BACKEND}/api/lichess-engine/paused`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused }),
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      const recovered = !paused && engineResumePending;
      engineResumePending = false;
      if (recovered) await broadcast({ type: 'ox-engine-resumed' }).catch(() => {});
      return;
    }
  } catch { /* The app can be restarting or busy. */ }
  engineResumePending = !paused;
  if (paused || appUp) {
    engineRetry = setTimeout(() => {
      engineRetry = null;
      // Match the current tabs when the retry runs, in the same queue as
      // navigation updates. Never replay an earlier unlock after a pause.
      return syncEngineLock().catch(() => {});
    }, 1000);
  }
}
async function syncEngineLock() {
  await seedLock();
  // Keepalive and reconnect requests must be ordered with lock changes,
  // otherwise a late keepalive can overwrite a newer pause.
  const change = lockQueue.then(async () => tellEngine((await playingTabs()).size > 0));
  lockQueue = change.catch(() => {});
  return change;
}
// The app starts paused (fail-closed: it can't know whether a game is on), so
// it is told the lock's state the moment it is seen answering after being
// down (or after this service worker restarted), not half a minute later.
let appUp = false;
async function noteApp(up) {
  if (up && !appUp) {
    appUp = true;
    await syncEngineLock();
  } else if (!up) {
    appUp = false;
  }
}

// Session storage is emptied when the extension is updated or Chrome restarts,
// and Lichess tabs already open don't report again until their new copy runs:
// until then a game in one of them must still count. So the first time the
// lock is asked about after that, every Lichess tab is looked at directly.
function looksLikeGame(url) {
  try {
    const { host, pathname } = new URL(url);
    if (host !== 'lichess.org') return false;
    if (globalThis.OX.isGameForecastPath(pathname)) return true;
    // Lichess TV, and a player's own TV page (/@/name/tv).
    if (/^\/tv(?:\/|$)/.test(pathname) || /^\/@\/[^/]+\/tv\/?$/.test(pathname)) return true;
    const id = /^\/(?:game\/)?([A-Za-z0-9]{8})(?:[A-Za-z0-9]{4})?(?:\/(?:white|black))?\/?$/.exec(pathname)?.[1];
    // Puzzles, Practice and a few more pages have an address of the same shape.
    return !!id && !globalThis.OX.notGames.includes(id);
  } catch { return false; }
}
async function tabIsLive(tab) {
  if (tab.discarded) return false; // unloaded by Chrome: nothing is shown in it
  const url = tab.pendingUrl || tab.url;
  const gameAddress = looksLikeGame(url);
  if (gameAddress && tab.status === 'loading') return true;
  // Forecasts use main.analyse even while their game is in progress.
  if (gameAddress && globalThis.OX.isGameForecastPath(new URL(url).pathname)) return true;
  try {
    const [{ result }] = await ext.scripting.executeScript({
      target: { tabId: tab.id },
      func: (round, finished) => !!document.querySelector(round) && !document.querySelector(finished),
      args: [A.roundPage.selector, A.roundFinished.selector],
    });
    return result === true;
  } catch {
    // Not readable right now (loading, an error page): a game's address counts as live.
    return gameAddress;
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

async function broadcast(message, exceptTab) {
  const tabs = await ext.tabs.query(LICHESS_TABS);
  await Promise.all(tabs.filter(tab => tab.id !== exceptTab).map(tab =>
    ext.tabs.sendMessage(tab.id, message).catch(() => {})));
}
const broadcastPaused = paused => broadcast({ type: 'ox-paused', paused });

ext.tabs.onRemoved.addListener(tabId => {
  loadingTabs.delete(tabId);
  setTabPlaying(tabId, false);
  stopIfUnwanted();
});
// Chrome can swap a tab for another one (and its id with it) without closing
// it; the new one reports for itself.
ext.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  loadingTabs.delete(removedTabId);
  try {
    const tab = await ext.tabs.get(addedTabId);
    if (await tabIsLive(tab)) await setTabPlaying(addedTabId, true);
  } finally {
    await setTabPlaying(removedTabId, false);
  }
});
// An entry whose tab no longer shows anything would hold the lock for ever:
// a tab that is gone without this worker hearing of it (it was asleep), or
// one Chrome unloaded to save memory (it reports again when it is opened).
// Looked at with every keepalive.
async function pruneLock() {
  for (const tabId of await playingTabs()) {
    let tab = null;
    try { tab = await ext.tabs.get(tabId); } catch { /* no such tab any more */ }
    if (!tab || tab.discarded || (tab.status === 'complete' && !tab.url?.startsWith('https://lichess.org/'))) {
      await setTabPlaying(tabId, false);
    }
  }
}
const loadingTabs = new Map();
ext.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.status === 'loading') {
    const url = change.url || tab.pendingUrl || tab.url;
    const lichess = url?.startsWith('https://lichess.org/');
    // A pending navigation can leave the old game visible until the new
    // document arrives, even when the destination is on a different site.
    if (lichess || tab.url?.startsWith('https://lichess.org/') || loadingTabs.has(tabId)) {
      loadingTabs.set(tabId, {});
    }
    if (lichess && looksLikeGame(url)) await setTabPlaying(tabId, true);
  }
  if (change.status === 'complete') {
    const load = loadingTabs.get(tabId);
    if (!load && !(await playingTabs()).has(tabId)) return;
    const playing = await tabIsLive(tab);
    if (loadingTabs.get(tabId) !== load) return;
    loadingTabs.delete(tabId);
    await setTabPlaying(tabId, playing);
  }
});

// --- your games into a Lichess study (backend/study_analysis.py) -------------
// When the last game in progress ends, the app fetches your new games at once
// (not at its next timed sync), so the game just played is in the study and
// being analysed before you go looking for it. A few seconds' wait lets
// Lichess finish the game on its side first.
const GAME_END_SYNC_DELAY_MS = 5000;
function gameEnded() {
  setTimeout(() => { client.api('POST', '/study-analysis/game-ended').catch(() => {}); },
    GAME_END_SYNC_DELAY_MS);
}

// An analysis the app has finished is published to its chapter from a Lichess
// tab: the same request as Lichess's own Publish button after "Analyse on
// your device", which needs your Lichess login (a token cannot make it).
// Never while a game is in progress, one at a time, and only from a tab
// signed in as the study's owner; otherwise it waits for the next try.
let publishing = null;
function publishReady() {
  publishing = publishing || (async () => {
    await seedLock();
    if ((await playingTabs()).size > 0) return;
    const answer = await client.api('GET', '/study-analysis/ready');
    const items = answer?.ok && Array.isArray(answer.data) ? answer.data : [];
    for (const item of items) {
      if ((await playingTabs()).size > 0) return;
      const tab = (await ext.tabs.query(LICHESS_TABS))
        .find(candidate => !candidate.discarded && candidate.status === 'complete');
      if (!tab) return;
      let outcome;
      try {
        [{ result: outcome }] = await ext.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN', func: publishInPage,
          args: [item.document, item.user_id],
        });
      } catch { return; } // the tab went away or is not scriptable: next time
      if (!outcome || outcome.wait) return;
      if (outcome.status >= 200 && outcome.status < 300) {
        await client.api('POST', `/study-analysis/${item.game_id}/published`);
      } else {
        await client.api('POST', `/study-analysis/${item.game_id}/publish-failed`,
          { status: outcome.status, message: String(outcome.message || '').slice(0, 2000) });
      }
    }
  })().catch(() => {}).finally(() => { publishing = null; });
  return publishing;
}

// Runs inside the Lichess page (its address and its login), not in this
// worker: Chrome copies the function there, so it uses nothing from here.
async function publishInPage(analysis, owner) {
  const me = document.body?.dataset?.user;
  if (!me || me.toLowerCase() !== String(owner || '').toLowerCase()) return { wait: true };
  try {
    const response = await fetch('/analysis/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(analysis),
    });
    return { status: response.status,
      message: response.ok ? '' : `${response.status} ${(await response.text()).slice(0, 300)}` };
  } catch (error) {
    return { status: 0, message: String(error) };
  }
}

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
  await pruneLock().catch(() => {});
  // Not answered means the app is down (it crashed, or was stopped by hand):
  // start it again, so Lichess's engine bar and the boxes come back by
  // themselves even on a page nobody touches.
  fetch(`${BACKEND}/api/keepalive`, { method: 'POST' })
    .then(res => {
      if (!res.ok) return noteApp(false);
      appUp = true;
      publishReady();
      return syncEngineLock();
    })
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
// What Lichess's engine service sends for the empty search answered during a
// game (backend/lichess_engine_provider.py BrokerEmit, "bestmove (none)").
const EMPTY_RESULT = '{"time":0,"depth":0,"nodes":0,"pvs":[],"bestmove":"(none)"}\n';

async function analyseHere(port, ask) {
  const controller = new AbortController();
  let open = true;
  port.onDisconnect.addListener(() => { open = false; controller.abort(); });
  const post = message => {
    if (!open) return;
    try { port.postMessage(message); } catch { open = false; controller.abort(); }
  };
  // Fail-closed, as the app is: during a game the answer is empty, and the
  // app is not even asked.
  await seedLock();
  if ((await playingTabs()).size > 0) {
    post({ kind: 'start' });
    post({ kind: 'chunk', text: EMPTY_RESULT });
    post({ kind: 'end' });
    return;
  }
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
        await seedLock();
        keepAlive();
        // Fail-closed: while this copy is about to be replaced, stay paused.
        if (await reloadIfUpdated()) return { paused: true, reloading: true };
        // Opening a Lichess page starts the app if it isn't running.
        const running = await appRunning();
        await noteApp(running);
        if (!running) await startApp();
        return { paused: (await playingTabs()).size > 0, autostart: running ? 'running' : autostart.state };
      }
      case 'ox-playing':
        await seedLock();
        if (reloadPending) {
          if (tabId != null && message.playing) await setTabPlaying(tabId, true);
          return { paused: true };
        }
        if (tabId == null || (!message.playing && loadingTabs.has(tabId))) {
          return { paused: (await playingTabs()).size > 0 };
        }
        if (!message.playing && globalThis.OX.isGameForecastPath(new URL(sender.tab.url || sender.url || BACKEND).pathname)) {
          return { paused: await setTabPlaying(tabId, true) };
        }
        return { paused: await setTabPlaying(tabId, message.playing) };
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
