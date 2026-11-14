#!/usr/bin/env node
// Checks the extension against the real lichess.org, without installing it.
//
//   node extension/scripts/check.mjs          (the openings app must be running on :8001)
//
// It opens Lichess pages in a headless Chrome, runs the extension's own
// content scripts in them (with a stand-in for the background script), and
// reports, per feature, whether it found its place and is visible. It also
// runs self-tests of the safety rules on small local copies of Lichess's
// game-page layout. Results go to the terminal, to
// extension/check-output/ (report + screenshots), and — for the real pages —
// to extension/health-report.json via the app, like the installed extension.
//
// Exit code 0: everything showed. 1: something is missing (see REPAIR.md).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BACKEND = process.env.OX_BACKEND || 'http://127.0.0.1:8001';
const outDir = join(extensionDir, 'check-output');
mkdirSync(outDir, { recursive: true });

const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
const contentFiles = manifest.content_scripts.find(c => c.js.includes('src/content.js')).js;
const read = file => readFileSync(join(extensionDir, file), 'utf8');

// The stand-in for bridge-extension.js: same shape, talks to the app through
// a fake https origin that this script answers (Lichess's page may not call
// http://127.0.0.1 itself).
const harnessBridge = `
(() => {
  const OX = (globalThis.OX = globalThis.OX || {});
  const client = globalThis.OX_createBackendClient('https://ox.invalid/api');
  let onPaused = null;
  const H = (globalThis.__oxHarness = {
    reports: [], playing: [], paused: false,
    setPaused(paused) { H.paused = paused; onPaused && onPaused(paused); },
  });
  OX.bridge = {
    version: ${JSON.stringify(manifest.version)} + '-check',
    async api(method, path, body) {
      let res;
      try { res = await client.api(method, path, body); }
      catch (e) { const err = new Error('offline'); err.offline = true; throw err; }
      if (!res.ok) { const err = new Error('HTTP ' + res.status); err.status = res.status; throw err; }
      return res.data;
    },
    report(report) { H.reports.push(report); },
    async openSettings() { return { ok: true }; },
    async setPlaying(playing) { H.playing.push(playing); return { paused: H.paused || playing }; },
    async status() { return { paused: H.paused }; },
    onPaused(callback) { onPaused = callback; },
    // Kept between pages, like the real extension's storage.
    async loadSettings() { try { return JSON.parse(localStorage.getItem('ox.check.settings') || '{}'); } catch { return {}; } },
    saveSettings(settings) { try { localStorage.setItem('ox.check.settings', JSON.stringify(settings)); } catch {} },
  };
})();`;

// src/page.css is put in by Chrome itself (manifest "css"); here by a script.
const pageStyle = `(() => {
  const add = () => {
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(read('src/page.css'))};
    (document.head || document.documentElement).append(style);
  };
  if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add, { once: true });
})();`;

const injected = [
  pageStyle,
  read('src/backend-client.js'),
  read('src/page-bridge.js'), // the real extension runs it in Lichess's page world
  ...contentFiles.map(file => (file === 'src/bridge-extension.js' ? harnessBridge : read(file))),
].join('\n;\n');

// Small local copies of Lichess's game page, for the safety self-tests.
const topnav = '<header id="top"><nav id="topnav"><section><a href="/">Play</a><div role="group"><a href="/">Create a game</a></div></section></nav></header>';
// A finished game page, shaped like Lichess's server-side underboard
// (ui/analyse/src/serverSideUnderboard.ts): the FEN box sits in a hidden panel.
const finishedGame = `<!doctype html><body>${topnav}
<main class="analyse variant-standard"><div class="analyse__board main-board"><div class="cg-wrap orientation-white"></div></div>
<div class="analyse__tools"><div class="ceval"></div><div class="analyse__moves areplay"><div class="tview2"><move p="/?" class="active"><san>e4</san></move></div></div></div>
<div class="analyse__underboard"><div class="analyse__underboard__menu"></div><div class="analyse__underboard__panels">
<div class="fen-pgn" style="display:none"><div class="analyse__underboard__fen"><input readonly value="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"></div></div></div></div>
<aside class="analyse__side"><div class="mselect"></div></aside>
</main></body>`;
// The opening explorer while open, shaped like lila's explorerView.ts
// (it needs a Lichess login, which the check doesn't have).
const explorerPage = `<!doctype html><body>${topnav}
<main class="analyse variant-standard"><aside class="analyse__side"></aside>
<div class="analyse__tools"><div class="ceval"></div>
<section class="explorer-box sub-box"><div class="overlay"></div><div class="data">
<div class="explorer-title"><button class="button-link">Masters</button><span class="active text lichess"><strong>Lichess</strong> database</span><button class="button-link player">Player</button><button class="fbt toconf"></button></div>
<table class="moves lichess-table"><tbody><tr><td>Nf3</td></tr></tbody></table></div></section></div>
<div class="analyse__underboard"><div class="copyables"><div class="pair"><input class="copyable" value="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"></div></div></div>
</main></body>`;
// The analysis board set up from a position (after 1.e4 e5), then 2.Nf3 Nc6:
// those moves are legal from the normal start too, but are not a line from it.
const customStart = `<!doctype html><body>${topnav}
<main class="analyse variant-fromPosition"><aside class="analyse__side"></aside>
<div class="analyse__board main-board"><div class="cg-wrap orientation-white"></div></div>
<div class="analyse__tools"><div class="ceval"></div><div class="analyse__moves areplay"><div class="tview2">
<move p="(0"><san>Nf3</san></move><move p="(0aA" class="active"><san>Nc6</san></move></div></div></div>
<div class="analyse__underboard"><div class="copyables"><div class="pair"><input class="copyable" value="r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"></div></div></div>
</main></body>`;
const fixtures = {
  '/ox-fixture/custom-start': customStart,
  '/ox-fixture/game': finishedGame,
  '/ox-fixture/explorer': explorerPage,
  '/ox-fixture/live': `<!doctype html><body>${topnav}<main class="round"><div class="rclock rclock-bottom running"></div></main></body>`,
  '/ox-fixture/finished': `<!doctype html><body>${topnav}<main class="round"><div class="rmoves"><div class="result-wrap">1-0</div></div></main></body>`,
};

const results = [];
let failures = 0;
const record = (page, ok, text) => {
  results.push({ page, ok, text });
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok ' : '  FAIL'}  ${text}`);
};

const browser = await chromium.launch({ channel: process.env.OX_CHROME_CHANNEL || 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, bypassCSP: true });
await context.addInitScript({ content: injected });
await context.route('https://ox.invalid/**', async route => {
  const request = route.request();
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE',
  };
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  try {
    const res = await fetch(request.url().replace('https://ox.invalid', BACKEND), {
      method: request.method(),
      headers: { 'content-type': 'application/json' },
      body: request.postData() ?? undefined,
    });
    const body = Buffer.from(await res.arrayBuffer());
    return route.fulfill({
      status: res.status, body,
      headers: { ...cors, 'content-type': res.headers.get('content-type') || 'application/json' },
    });
  } catch {
    return route.abort('connectionrefused');
  }
});
await context.route('https://lichess.org/ox-fixture/**', route => {
  const html = fixtures[new URL(route.request().url()).pathname];
  return route.fulfill({ status: 200, contentType: 'text/html', body: html });
});

const page = await context.newPage();
if (process.env.OX_DEBUG) {
  page.on('pageerror', e => console.log('PAGEERROR', page.url().slice(0, 60), String(e).slice(0, 300)));
  page.on('console', m => { if (/openings|OX|ox\./i.test(m.text())) console.log('CONSOLE', m.type(), m.text().slice(0, 300)); });
}
const statuses = () => page.evaluate(() => globalThis.OX.runner.status());
const hosts = () => page.evaluate(() => [...document.querySelectorAll('[data-ox-host]')].map(h => {
  const r = h.getBoundingClientRect();
  return { id: h.dataset.oxHost, w: Math.round(r.width), h: Math.round(r.height) };
}));
const lastReport = () => page.evaluate(() => globalThis.__oxHarness.reports.at(-1));
const waitSettled = () => page.waitForFunction(
  () => globalThis.OX?.runner && !Object.values(globalThis.OX.runner.status()).includes('waiting'),
  null, { timeout: 15000 }).catch(() => {});

// The real extension also runs engine-select.js at document_start.
await context.addInitScript({ content: read('src/engine-select.js') });

async function open(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  await waitSettled();
}

function expectStatuses(label, actual, expected) {
  for (const [id, want] of Object.entries(expected)) {
    record(label, actual[id] === want, `${label}: ${id} is ${actual[id]} (expected ${want})`);
  }
}

const realReports = [];

// 1. The analysis board with a few moves: every feature should show.
console.log('\nLichess analysis board');
await open(`https://lichess.org/analysis/pgn/${process.env.OX_CHECK_MOVES || 'e4_e5_Nf3_Nc6_Bb5'}`);
await page.waitForTimeout(3500); // let the engine and the app's answers arrive
const analysis = await statuses();
expectStatuses('analysis', analysis, { engine: 'ok', repertoire: 'ok', game: 'ok', mine: 'n/a' });
record('analysis', await page.evaluate(() => getComputedStyle(document.querySelector('#wikibook-field, .analyse__wiki')).display === 'none'),
  "analysis: Lichess's WikiBook is hidden");
const shown = await hosts();
const repertoireHost = shown.find(h => h.id === 'repertoire');
record('analysis', !!repertoireHost && repertoireHost.h > 0, `analysis: repertoire is on the page (${repertoireHost ? `${repertoireHost.w}×${repertoireHost.h}px` : 'absent'})`);
{
  const fit = await page.evaluate(() => {
    const side = document.querySelector('aside.analyse__side').getBoundingClientRect();
    const board = document.querySelector('main.analyse .cg-wrap').getBoundingClientRect();
    return { side: Math.round(side.bottom), board: Math.round(board.bottom), beside: side.right <= board.left };
  });
  record('analysis', !fit.beside || fit.side <= fit.board + 2, `analysis: the left column is no taller than the board (${fit.side} vs ${fit.board})`);
}
const engineState = await (await fetch(`${BACKEND}/api/lichess-engine`)).json();
const engineText = await page.evaluate(() =>
  document.querySelector('[data-ox-host=engine]')?.shadowRoot?.querySelector('.ox')?.textContent || '');
const chosen = await page.evaluate(() => localStorage.getItem('ceval.engine.standard'));
if (engineState.state === 'ready') {
  record('analysis', chosen === engineState.engine_id,
    `analysis: Lichess's engine is set to your Stockfish (${chosen})`);
  // A fresh page load must pick it before Lichess starts (engine-select.js).
  await open('https://lichess.org/analysis/pgn/e4_e5_Nf3');
  const box = await page.evaluate(() =>
    document.querySelector('[data-ox-host=engine]')?.shadowRoot?.querySelector('.ox')?.textContent || '');
  record('analysis', box === '', `analysis: once chosen, the engine box stays out of the way (“${box.slice(0, 50)}”)`);
} else {
  record('analysis', engineText.length > 0, `analysis: the engine box explains what's missing (“${engineText.slice(0, 70)}”)`);
}
await page.screenshot({ path: join(outDir, 'analysis.png') });
realReports.push(await lastReport());

// Stepping back a move updates every feature to the new position.
const fenBefore = await page.evaluate(() => globalThis.OX.state.position?.fen);
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(1200);
const fenAfter = await page.evaluate(() => globalThis.OX.state.position?.fen);
record('analysis', fenBefore && fenAfter && fenBefore !== fenAfter, 'analysis: the extension follows moves on the board');

// 2. A study: no FEN box, so the position comes from the move list.
const STUDY = process.env.OX_CHECK_STUDY || 'https://lichess.org/study/Of3mcPk8';
console.log(`\nLichess study (${STUDY})`);
await open(STUDY);
await page.waitForTimeout(2000);
const study = await statuses();
if (await page.evaluate(() => globalThis.OX.interactiveLesson())) {
  record('study', study.engine === 'n/a', 'study: this chapter is an interactive lesson, so nothing is shown (pick a normal study with OX_CHECK_STUDY)');
} else {
  expectStatuses('study', study, { engine: 'ok', repertoire: 'ok' });
  const studyFen = () => page.evaluate(() => globalThis.OX.state.position?.fen);
  const atStart = await studyFen();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(1200);
  const moved = await studyFen();
  record('study', !!atStart && !!moved && atStart !== moved, `study: the position follows the move list (${moved})`);
  await page.screenshot({ path: join(outDir, 'study.png') });
  realReports.push(await lastReport());
}

// 3. A plain page: nothing.
console.log('\nLichess home page');
await open('https://lichess.org/');
const home = await statuses();
expectStatuses('home', home, { engine: 'n/a', repertoire: 'n/a' });
record('home', (await hosts()).length === 0, 'home: nothing of the extension is on the page');
await page.screenshot({ path: join(outDir, 'home.png'), clip: { x: 0, y: 0, width: 1440, height: 160 } });
realReports.push(await lastReport());

// 4. Your game, opened from My games: the game card in the left column.
console.log('\nOpening one of your games');
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const someGame = (await (await fetch(`${BACKEND}/api/position-games?${new URLSearchParams({ fen: START_FEN, limit: 1 })}`)).json()).games?.[0];
if (someGame) {
  await open('https://lichess.org/analysis');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.evaluate(id => globalThis.OX.openMyGame(id, 6), someGame.id)]);
  await page.waitForTimeout(3000);
  await waitSettled();
  const card = await page.evaluate(() => document.querySelector('[data-ox-host=game]')?.shadowRoot?.querySelector('.ox')?.textContent || '');
  record('your game', card.includes(`vs ${someGame.user_color === 'white' ? someGame.black : someGame.white}`),
    `your game: opens on Lichess's board with its card (“${card.slice(0, 70)}”)`);
  record('your game', (await page.evaluate(() => globalThis.OX.state.position?.fen?.split(' ')[5])) === '4',
    'your game: opened at the requested move');
  await page.screenshot({ path: join(outDir, 'your-game.png') });
}

// 5. Safety self-tests on local copies of Lichess's game page.
console.log('\nSafety self-tests');
await open('https://lichess.org/ox-fixture/live');
const live = await statuses();
expectStatuses('live game', live, { engine: 'n/a', repertoire: 'n/a' });
record('live game', (await page.evaluate(() => globalThis.__oxHarness.playing.at(-1))) === true,
  'live game: the game page locks every Lichess tab');
record('live game', (await hosts()).length === 0, 'live game: nothing of the extension is on the page');

// While the game stays on screen the page keeps saying so (a lock the
// background script lost must come back by itself).
await page.waitForTimeout(6000);
record('live game', (await page.evaluate(() => globalThis.__oxHarness.playing.filter(Boolean).length)) >= 2,
  'live game: the lock is reported again while the game is on');

await open('https://lichess.org/ox-fixture/game');
const game = await statuses();
expectStatuses('finished-game layout', game, { engine: 'ok', repertoire: 'ok' });

// The My games tab in the explorer (local copy of its logged-in layout).
await open('https://lichess.org/ox-fixture/explorer');
record('explorer', (await statuses()).mine === 'ok', 'explorer: the My games tab is added');
record('explorer', await page.evaluate(() => document.querySelector('.ox-tab')?.nextElementSibling?.classList.contains('toconf')),
  "explorer: it sits in Lichess's tab row, before the gear");
await page.click('.ox-tab');
await page.waitForFunction(() => !!document.querySelector('.ox-mine-content .ox-side'), null, { timeout: 15000 }).catch(() => {});
record('explorer', await page.evaluate(() => {
  const box = document.querySelector('.explorer-box');
  const content = document.querySelector('.ox-mine-content');
  return box.classList.contains('ox-mine')
    && getComputedStyle(document.querySelector('.lichess-table')).display === 'none'
    && !!content.querySelector('.ox-side')
    && (content.querySelectorAll('table.moves tbody tr').length > 0 || !!content.querySelector('.ox-empty'));
}), "explorer: choosing it shows your moves or empty state in place of Lichess's");
await page.screenshot({ path: join(outDir, 'explorer.png') });
// Reopening a page with My games still chosen (this broke twice).
await open('https://lichess.org/ox-fixture/explorer');
await page.waitForFunction(() => !!document.querySelector('.ox-mine-content .ox-side'), null, { timeout: 15000 }).catch(() => {});
record('explorer', (await statuses()).mine === 'ok' && await page.evaluate(() =>
  document.querySelector('.ox-tab')?.textContent === 'My games'
  && /As (white|black)/.test(document.querySelector('.ox-mine-content .ox-side')?.textContent || '')),
  'explorer: a page opened with My games already chosen shows its side and content');
await page.click('.explorer-title .button-link:not(.ox-tab)');
await page.waitForTimeout(400);
record('explorer', await page.evaluate(() => !document.querySelector('.explorer-box').classList.contains('ox-mine')),
  "explorer: choosing one of Lichess's tabs leaves My games");
record('finished-game layout',
  (await page.evaluate(() => globalThis.OX.state.position?.fen))?.startsWith('rnbqkbnr/pppppppp/8/8/4P3'),
  'finished-game layout: the position is read from the game page\'s FEN box');

await open('https://lichess.org/ox-fixture/custom-start');
await page.waitForTimeout(1500);
record('custom start', await page.evaluate(() => globalThis.OX.currentLine() === null
  && !/save this line/i.test(document.querySelector('[data-ox-host=repertoire]')?.shadowRoot?.textContent || '')),
  'custom start: moves from a set-up position are not offered as a line to save');

await open('https://lichess.org/ox-fixture/finished');
record('finished game', (await page.evaluate(() => globalThis.__oxHarness.playing.at(-1))) === false,
  'finished game: the lock is released once the result shows');

await open('https://lichess.org/analysis/pgn/e4_e5');
await page.evaluate(() => globalThis.__oxHarness.setPaused(true)); // a game started in another tab
await page.waitForTimeout(800);
const paused = await statuses();
expectStatuses('paused', paused, { engine: 'paused', repertoire: 'paused', mine: 'paused' });
record('paused', (await hosts()).length === 0, 'paused: the boxes are removed while a game runs elsewhere');
await page.evaluate(() => globalThis.__oxHarness.setPaused(false));
await page.waitForTimeout(800);
record('paused', (await statuses()).engine === 'ok', 'paused: everything returns when the game ends');

// An extension update puts a second copy into the same page: the first must
// step aside completely, and the new one must take over (once, not twice).
await page.evaluate(code => { (0, eval)(code); }, injected);
await page.waitForTimeout(1500);
await waitSettled();
{
  const ids = (await hosts()).map(h => h.id);
  record('update', ids.length > 0 && new Set(ids).size === ids.length && (await statuses()).repertoire === 'ok',
    `update: a second copy replaces the first, nothing twice (${ids.join(', ')})`);
}

// A simulated Lichess change: the left column is renamed. The features there
// must drop out and be reported; the page and the rest keep working.
await page.evaluate(() => { document.querySelector('aside.analyse__side').className = 'renamed-by-lichess'; });
await page.waitForTimeout(2500);
const changed = await statuses();
expectStatuses('simulated change', changed, { repertoire: 'missing', engine: 'ok' });
const changedReport = await lastReport();
record('simulated change',
  changedReport?.features?.repertoire?.missing_anchors?.[0]?.name === 'side',
  'simulated change: the report names the anchor that stopped matching (side)');
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error)));
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(800);
record('simulated change', pageErrors.length === 0, `simulated change: Lichess's page has no errors (${pageErrors.length})`);

await browser.close();

// The real pages' reports go to the app, exactly as the installed extension sends them.
for (const report of realReports.filter(Boolean)) {
  await fetch(`${BACKEND}/api/extension/health`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report),
  }).catch(() => {});
}

writeFileSync(join(outDir, 'report.json'), JSON.stringify({ checked_at: new Date().toISOString(), failures, results, realReports }, null, 2));
console.log(failures
  ? `\n${failures} check(s) failed. Details: extension/check-output/report.json — fix guide: extension/REPAIR.md`
  : '\nEverything showed and every safety rule held.');
process.exit(failures ? 1 : 0);
