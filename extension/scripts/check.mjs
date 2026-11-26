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
  let onRepertoireChanged = null;
  const H = (globalThis.__oxHarness = {
    reports: [],
    repertoireChanged() { onRepertoireChanged?.(); },
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
    async status() { return {}; },
    onRepertoireChanged(callback) { onRepertoireChanged = callback; },
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
// A study chapter that starts from a set-up position (an endgame lesson):
// no FEN box, and Lichess lists no FEN among the chapter's tags, so only its
// controller (window.site.analysis) knows the position.
const SETUP_FEN = '8/8/2K5/3R4/8/8/8/k7 w - - 0 1';
const studySetUp = `<!doctype html><body>${topnav}
<main class="analyse variant-standard"><aside class="analyse__side"></aside>
<div class="analyse__board main-board"><div class="cg-wrap orientation-white"></div></div>
<div class="analyse__tools"><div class="ceval"></div><div class="analyse__moves areplay"><div class="tview2"></div></div></div>
<div class="analyse__underboard"><table class="study__tags"><tbody><tr><th>Event</th><td>Rook endgames</td></tr></tbody></table></div>
</main><script>window.site = { analysis: { node: { fen: '${SETUP_FEN}' }, tree: { root: { fen: '${SETUP_FEN}' } } } };</script></body>`;
// A study chapter of yours where every move has a result, for Annotate
// chapter. Its controller is a stand-in with the fields page-bridge.js reads;
// window.__oxNextChapter() switches to another chapter as Lichess does.
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const studyAnnotate = `<!doctype html><body>${topnav}
<main class="analyse variant-standard"><aside class="analyse__side"></aside>
<div class="analyse__board main-board"><div class="cg-wrap orientation-white"></div></div>
<div class="analyse__tools"><div class="ceval"></div><div class="analyse__moves areplay"><div class="tview2"></div></div></div>
</main><script>
  const node = (ply, fen, uci, san, cp, best) => ({ ply, fen, uci, san, ceval: { cp, depth: 20, nodes: 1000, pvs: [{ moves: [best] }] } });
  const line = () => [node(0, '${START}', null, null, 20, 'e2e4'), node(1, '${AFTER_E4}', 'e2e4', 'e4', 25, 'e7e5'),
    node(2, '${AFTER_E5}', 'e7e5', 'e5', 20, 'g1f3')];
  window.site = { analysis: {
    node: { fen: '${AFTER_E5}' }, tree: { root: { fen: '${START}' } }, mainline: line(),
    study: { data: { id: 'oxFixt01', chapter: { id: 'chapter1' } }, vm: { chapterId: 'chapter1' },
      members: { canContribute: () => true } },
  } };
  window.__oxNextChapter = () => { site.analysis.study.vm.chapterId = 'chapter2'; site.analysis.mainline = line(); };
</script></body>`;
// The explorer with its settings open (the gear), as lila draws it.
const explorerSettings = explorerPage.replace('explorer-box sub-box', 'explorer-box sub-box explorer__config')
  .replace('<div class="data">', '<div class="config">');
const fixtures = {
  '/ox-fixture/explorer-settings': explorerSettings,
  '/ox-fixture/study-set-up': studySetUp,
  '/ox-fixture/explorer-variant': explorerPage.replace('variant-standard', 'variant-crazyhouse'),
  '/ox-fixture/custom-start': customStart,
  '/ox-fixture/game': finishedGame,
  '/ox-fixture/explorer': explorerPage,
  // A position past the moves My games follows, in an explorer with nothing
  // of Lichess's own to show: lila keeps that state's text on one line.
  '/ox-fixture/explorer-late': explorerPage.replace('<div class="data">', '<div class="data empty">')
    .replace('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', '6k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 41')
    .replace('<main', '<style>.explorer-box { width: 350px; overflow: hidden; } .explorer-box .data.empty { white-space: nowrap; }</style><main'),
  '/ox-fixture/repertoire-delete': explorerPage.replace('<div class="ceval"></div>',
    '<div class="ceval"></div><div class="analyse__moves"><move p="aa" class="active"><san>e4</san></move></div>'),
  '/ox-fixture/pagination': explorerPage,
  '/ox-fixture/live': `<!doctype html><body>${topnav}<main class="round"><div class="rclock rclock-bottom running"></div></main></body>`,
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
let pageAttempts = 0;
let historyChanged = false;
let deleteAttempts = 0;
let deleteSnapshot = null;
let editPatch = null;
let repertoireFetches = 0;
await context.route('https://ox.invalid/**', async route => {
  const request = route.request();
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
  };
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  if (new URL(request.frame().url()).pathname === '/ox-fixture/repertoire-delete') {
    const url = new URL(request.url());
    const headers = { ...cors, 'content-type': 'application/json' };
    if (url.pathname === '/api/repertoire/tree') {
      repertoireFetches++;
      const color = url.searchParams.get('color');
      const branches = color === 'white' ? [
        { id: 2, name: editPatch?.name ?? 'Fixture opening', moves_san: editPatch?.moves_san ?? 'e4 e5 Nf3 Nc6', label: editPatch?.label ?? 'main' },
        ...(!deleteAttempts ? [{ id: 1, name: '', moves_san: 'Nf3 Nc6 e4 e5', label: 'sideline' }] : []),
      ] : [];
      return route.fulfill({ status: 200, headers, json: { color, branches } });
    }
    if (url.pathname === '/api/repertoire/tree/branches/1' && request.method() === 'DELETE') {
      const first = ++deleteAttempts === 1;
      deleteSnapshot = request.postDataJSON();
      await new Promise(resolve => setTimeout(resolve, 250));
      return route.fulfill({ status: first ? 200 : 404, headers, json: {} });
    }
    if (url.pathname === '/api/repertoire/tree/branches/2' && request.method() === 'PATCH') {
      // The line was deleted in another tab meanwhile.
      if (request.postDataJSON()?.name === 'Deleted elsewhere') return route.fulfill({ status: 404, headers, json: {} });
      editPatch = request.postDataJSON();
      return route.fulfill({ status: 200, headers, json: {} });
    }
  }
  if (new URL(request.frame().url()).pathname === '/ox-fixture/pagination') {
    const url = new URL(request.url());
    const headers = { ...cors, 'content-type': 'application/json' };
    if (url.pathname === '/api/opening-tree') {
      return route.fulfill({ status: 200, headers, json: {
        total_games: 16, summary: { score: 50 },
        moves: [{ san: 'e5', uci: 'e7e5', games: 16, win: 8, loss: 8, draw: 0, score: 50 }],
      } });
    }
    if (url.pathname === '/api/position-games') {
      const offset = Number(url.searchParams.get('offset'));
      if (offset && ++pageAttempts === 1) return route.fulfill({ status: 503, headers, json: {} });
      if (offset && url.searchParams.get('revision') === 'old' && historyChanged) {
        return route.fulfill({ status: 409, headers, json: {} });
      }
      const games = Array.from({ length: offset ? 1 : 15 }, (_, i) => ({
        id: i + offset + 1 + Number(historyChanged), user_color: 'white', white: 'White', black: 'Black', result: '1/2-1/2',
      }));
      return route.fulfill({ status: 200, headers, json: { games, total: 16, revision: historyChanged ? 'new' : 'old' } });
    }
  }
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

// Since Nov 2026 Lichess (Cloudflare) answers headless Chrome with a "verify
// you are human" page. Never get round it: the checks on real Lichess pages
// are then skipped (check those in the real Chrome, TESTING.md pass 2) and
// the rest run on the local copies below.
await page.goto('https://lichess.org/analysis', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2500);
const realLichess = await page.evaluate(() => !!document.querySelector('main.analyse')
  || !/security verification|verify you are human/i.test(document.body?.innerText || '')).catch(() => false);
if (!realLichess) console.log('\n  skip  real Lichess pages: Lichess shows its bot check to headless Chrome; check them in the real Chrome');

if (realLichess) {
// 1. The analysis board with a few moves: every feature should show.
console.log('\nLichess analysis board');
await open(`https://lichess.org/analysis/pgn/${process.env.OX_CHECK_MOVES || 'e4_e5_Nf3_Nc6_Bb5'}`);
await page.waitForTimeout(3500); // let the engine and the app's answers arrive
const analysis = await statuses();
expectStatuses('analysis', analysis, { engine: 'ok', repertoire: 'ok', mine: 'n/a' });
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

if (process.env.OX_CHECK_NARROW === '1') {
  await page.setViewportSize({ width: 420, height: 900 });
  const narrowLayout = () => {
    const board = document.querySelector('main.analyse .cg-wrap').getBoundingClientRect();
    const panel = document.querySelector('[data-ox-host=repertoire]');
    const overflow = document.documentElement.scrollWidth - innerWidth;
    return {
      stacked: panel.getBoundingClientRect().top >= board.bottom - 2,
      cap: panel.style.getPropertyValue('--ox-max'),
      overflow,
      overflowing: overflow > 1 ? [...document.querySelectorAll('body *')]
        .filter(element => element.getBoundingClientRect().right > innerWidth + 1)
        .slice(0, 8).map(element => `${element.localName}.${element.getAttribute('class') || ''}`) : [],
    };
  };
  let narrow;
  for (let attempt = 0; attempt < 10; attempt++) {
    narrow = await page.evaluate(narrowLayout);
    if (narrow.stacked && !narrow.cap && narrow.overflow <= 1) break;
    await page.waitForTimeout(250);
  }
  record('narrow analysis', narrow.stacked && !narrow.cap && narrow.overflow <= 1,
    `narrow analysis: stacked ${narrow.stacked}, height cap ${narrow.cap || 'none'}, overflow ${narrow.overflow}px`
      + (narrow.overflowing.length ? ` (${narrow.overflowing.join(', ')})` : ''));
  await page.setViewportSize({ width: 1440, height: 1000 });
}

// Stepping back a move updates every feature to the new position.
const fenBefore = await page.evaluate(() => globalThis.OX.state.position?.fen);
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(1200);
const fenAfter = await page.evaluate(() => globalThis.OX.state.position?.fen);
record('analysis', fenBefore && fenAfter && fenBefore !== fenAfter, 'analysis: the extension follows moves on the board');

// Saving a line: the opening's name is suggested, selected so that typing
// a name of your own replaces it.
{
  const form = await page.evaluate(async () => {
    const root = document.querySelector('[data-ox-host=repertoire]')?.shadowRoot;
    [...(root?.querySelectorAll('button') || [])].find(b => /save this line/i.test(b.textContent))?.click();
    await new Promise(resolve => setTimeout(resolve, 1500));
    const name = root?.querySelector('.saveform input');
    const state = name && { value: name.value, selected: name.selectionStart === 0 && name.selectionEnd === name.value.length, focused: root.activeElement === name };
    return state;
  });
  record('analysis', !!form?.value && form.selected && form.focused,
    `analysis: Save this line suggests the opening's name, selected for typing over (“${form?.value || ''}”)`);
  await page.getByRole('button', { name: 'As Black', exact: true }).press('Enter');
  record('repertoire', await page.evaluate(() => {
    const root = document.querySelector('[data-ox-host=repertoire]').shadowRoot;
    return root.activeElement?.textContent === 'As Black' && root.activeElement.getAttribute('aria-pressed') === 'true';
  }), 'repertoire: keyboard color selection keeps focus and exposes the selected side');
  await page.getByRole('textbox', { name: 'Name of the line' }).press('Escape');
  record('repertoire', await page.evaluate(() => {
    const root = document.querySelector('[data-ox-host=repertoire]').shadowRoot;
    return !root.querySelector('.saveform') && root.activeElement?.classList.contains('ox-open-save');
  }), 'repertoire: Escape closes the save form and returns focus to Save this line');
}

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

// 4. Your game, opened from My games: on the board, at the move asked for.
console.log('\nOpening one of your games');
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const history = (await (await fetch(`${BACKEND}/api/position-games?${new URLSearchParams({ fen: START_FEN, limit: 100 })}`)).json()).games || [];
// A native Lichess game already shows both names. Use the Chess.com route
// for the imported card assertions below, independent of the latest sync.
const someGame = history.find(game => game.source === 'chesscom');
if (someGame) {
  await open('https://lichess.org/analysis');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.evaluate(id => globalThis.OX.openMyGame(id, 6), someGame.id)]);
  await page.waitForTimeout(3000);
  await waitSettled();
  const black = await page.evaluate(() => document.querySelector('main.analyse .cg-wrap')?.classList.contains('orientation-black'));
  record('your game', black === (someGame.user_color === 'black'), 'your game: opens on the board from your side');
  record('your game', (await page.evaluate(() => globalThis.OX.state.position?.fen?.split(' ')[5])) === '4',
    'your game: opened at the requested move');
  await page.screenshot({ path: join(outDir, 'your-game.png') });
}

}

// 5. Safety self-tests on local copies of Lichess's game page.
console.log('\nSafety self-tests');
await context.route('https://lichess.org/game/oxFixt03/black/analysis', route =>
  route.fulfill({ status: 200, contentType: 'text/html', body: explorerPage }));
await open('https://lichess.org/game/oxFixt03/black/analysis');
expectStatuses('game forecast', await statuses(), { engine: 'n/a', repertoire: 'n/a' });
record('game forecast', (await hosts()).length === 0,
  'game forecast: the analysis board of a game in progress shows nothing of the extension');

await open('https://lichess.org/ox-fixture/live');
const live = await statuses();
expectStatuses('live game', live, { engine: 'n/a', repertoire: 'n/a' });
record('live game', (await hosts()).length === 0, 'live game: nothing of the extension is on the page');

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
await open('https://lichess.org/ox-fixture/game');
record('finished-game layout',
  (await page.evaluate(() => globalThis.OX.state.position?.fen))?.startsWith('rnbqkbnr/pppppppp/8/8/4P3'),
  'finished-game layout: the position is read from the game page\'s FEN box');

await open('https://lichess.org/ox-fixture/pagination');
await page.getByRole('button', { name: 'My games' }).click();
await page.locator('.ox-side').focus();
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.activeElement?.matches('.ox-side'));
record('explorer keyboard', await page.locator('.ox-side').textContent() === 'As black ⇄',
  'explorer: switching sides with Enter keeps focus on the side button');
await page.keyboard.press('Tab');
await page.keyboard.press('Tab');
record('explorer keyboard', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Play e5'),
  'explorer: Tab reaches the move button');
await page.keyboard.press('Tab');
record('explorer keyboard', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Open White vs Black'),
  'explorer: Tab reaches the first game button');
await page.getByRole('button', { name: 'More games' }).press('Enter');
const retry = page.getByRole('button', { name: 'Retry loading more games' });
await retry.waitFor({ timeout: 5000 });
const rows = page.locator('.ox-mine-content .games tbody tr');
record('pagination', await rows.count() === 15 && await retry.evaluate(el => el === document.activeElement),
  'pagination: a failed request keeps the games already loaded and focuses retry');
await retry.press('Enter');
await rows.nth(15).waitFor({ timeout: 5000 });
record('pagination', await rows.count() === 16 && pageAttempts === 2
  && await rows.nth(15).evaluate(el => el.contains(document.activeElement)),
  'pagination: retry appends the missing games once and focuses the first new game');
await page.locator('.ox-side').click();
await rows.first().waitFor();
historyChanged = true;
await page.getByRole('button', { name: 'More games' }).press('Enter');
await page.getByText('Your game list changed. Showing the newest games again.').waitFor();
record('pagination', await rows.count() === 15 && await rows.first().getAttribute('data-id') === '2',
  'pagination: an import between pages refreshes the first page without appending duplicates');
// Lichess's Space shortcut (play the best move) listens on the document, and
// My games sits in Lichess's own page, not in a shadow root: Space on one of
// its buttons played a move and moved the board away (real Chrome).
await page.evaluate(() => {
  window.__oxSpaceSeen = 0;
  for (const type of ['keydown', 'keypress', 'keyup']) {
    document.addEventListener(type, event => { if (event.key === ' ') window.__oxSpaceSeen++; });
  }
});
const sideBefore = await page.locator('.ox-side').textContent();
await page.locator('.ox-side').focus();
await page.keyboard.press(' ');
await page.waitForFunction(before => document.querySelector('.ox-side')?.textContent !== before, sideBefore, { timeout: 3000 }).catch(() => {});
const sideSwitched = await page.locator('.ox-side').textContent() !== sideBefore;
// The tab itself is a button in Lichess's tab row too (Space on it switches sides, like a click).
await page.locator('.ox-tab').focus();
await page.keyboard.press(' ');
await page.waitForTimeout(300);
record('explorer keyboard', await page.evaluate(() => window.__oxSpaceSeen) === 0 && sideSwitched,
  "explorer: Space on a My games button works it and never reaches Lichess's shortcuts (Space plays the best move)");

await open('https://lichess.org/ox-fixture/repertoire-delete');
const repertoire = page.locator('[data-ox-host=repertoire]');
const savedLines = repertoire.locator('.saved-line');
const moveOrder = line => line.locator('.line-moves');
record('repertoire position', await savedLines.count() === 1 && await moveOrder(savedLines.first()).textContent() === '1. e4 e5 2. Nf3 Nc6',
  'repertoire: the current position shows its saved line immediately');
await repertoire.getByRole('button', { name: 'Manage saved lines' }).click();
const lineSearch = page.getByRole('searchbox', { name: 'Find a repertoire line' });
await lineSearch.fill('Nf3 Nc6 e4');
await lineSearch.press('ArrowLeft');
const beforeRefresh = repertoireFetches;
await page.evaluate(() => globalThis.__oxHarness.repertoireChanged());
await page.waitForFunction(() => {
  const root = document.querySelector('[data-ox-host=repertoire]').shadowRoot;
  return root.querySelector('.line-matches')?.textContent === '1 of 2';
});
// Wait for both replies and the asynchronous redraw, before inspecting focus.
await page.waitForTimeout(400);
record('repertoire filter', repertoireFetches === beforeRefresh + 2 &&
  await lineSearch.evaluate(input => input === input.getRootNode().activeElement && input.selectionStart === 9),
  'repertoire: a change in another tab keeps filter focus and cursor position');
record('repertoire filter', await moveOrder(savedLines.filter({ visible: true }).first()).textContent() === '1. Nf3 Nc6 2. e4 e5',
  'repertoire: an unnamed line is searchable by its moves');
await repertoire.getByRole('button', { name: 'Back to board position' }).click();

const setRepertoirePosition = sans => page.evaluate(moves => {
  const chess = new globalThis.OXChess();
  const list = document.querySelector('.analyse__moves');
  list.replaceChildren(...moves.map((san, i) => {
    chess.move(san);
    const move = document.createElement('move');
    move.setAttribute('p', 'aa'.repeat(i + 1));
    move.classList.toggle('active', i === moves.length - 1);
    const notation = document.createElement('san');
    notation.textContent = san;
    move.append(notation);
    return move;
  }));
  document.querySelector('.copyable').value = chess.fen();
}, sans);
await setRepertoirePosition(['e4', 'c5']);
await repertoire.getByRole('heading', { name: 'Saved lines before 1… c5' }).waitFor();
record('repertoire position', await savedLines.count() === 1 && !await savedLines.first().getByRole('button', { name: /Play the rest/ }).count(),
  'repertoire: an unsaved continuation shows the last saved position with its own heading');
await setRepertoirePosition(['Nf3', 'Nc6', 'e4', 'e5']);
await repertoire.getByRole('heading', { name: 'Saved lines at this position' }).waitFor();
record('repertoire position', await savedLines.count() === 2 && await moveOrder(savedLines.first()).textContent() === '1. Nf3 Nc6 2. e4 e5'
  && await savedLines.nth(1).getByText(/Other move order/).isVisible(),
  'repertoire: the unnamed line on the board comes before the main line that transposes');
await savedLines.first().getByRole('button', { name: 'Delete this line' }).click();
const confirmation = repertoire.locator('.linerow.confirm');
record('repertoire delete', await confirmation.getByText('1. Nf3 Nc6 2. e4 e5', { exact: true }).isVisible(),
  'repertoire: the confirmation shows the exact move order of the line on the board');
await confirmation.getByRole('button', { name: 'Cancel' }).click();
record('repertoire delete', deleteAttempts === 0 && await confirmation.count() === 0,
  'repertoire: cancelling leaves the line saved');
await savedLines.first().getByRole('button', { name: 'Delete this line' }).click();
await confirmation.getByRole('button', { name: 'Delete', exact: true }).dblclick();
await repertoire.getByText('Line deleted.').waitFor();
record('repertoire delete', deleteAttempts === 1 && await savedLines.count() === 1,
  'repertoire: double-clicking Delete removes the line and sends one request');
record('repertoire delete', deleteSnapshot?.name === '' &&
  deleteSnapshot?.moves_san === 'Nf3 Nc6 e4 e5' && deleteSnapshot?.label === 'sideline',
  'repertoire: Delete sends the exact line that was confirmed');
record('repertoire position', await repertoire.getByText('1. e4 e5 2. Nf3 Nc6', { exact: true }).isVisible(),
  'repertoire: the other move order stays saved');

await savedLines.first().getByRole('button', { name: 'Edit this line' }).click();
const lineEditor = repertoire.locator('.line-editor');
await lineEditor.getByRole('heading', { name: 'Edit White line' }).waitFor();
const editName = lineEditor.getByRole('textbox', { name: 'Name' });
const editKind = lineEditor.getByRole('combobox', { name: 'Line type' });
const saveChanges = lineEditor.getByRole('button', { name: 'Save changes' });
record('repertoire edit', await editName.inputValue() === 'Fixture opening' && await editKind.inputValue() === 'main'
  && await saveChanges.isDisabled(), 'repertoire: Edit opens the existing line and only enables Save after a change');
await setRepertoirePosition(['e4', 'c5', 'Nf3']);
await page.waitForFunction(() => globalThis.OX.state.position?.fen.includes(' b '));
await lineEditor.getByRole('button', { name: 'Use board moves' }).click();
record('repertoire edit', await lineEditor.getByText('1. e4 c5 2. Nf3', { exact: true }).isVisible() && editPatch === null,
  'repertoire: the editor stays open while the board changes and previews the replacement before saving');
await saveChanges.click();
await repertoire.getByText('Line updated.').waitFor();
record('repertoire edit', editPatch?.moves_san === 'e4 c5 Nf3' && editPatch.expected?.moves_san === 'e4 e5 Nf3 Nc6'
  && !('name' in editPatch) && !('label' in editPatch), 'repertoire: replacing moves updates the same line and retains its name and type');
record('repertoire edit', await savedLines.count() === 1 && await moveOrder(savedLines.first()).textContent() === '1. e4 c5 2. Nf3',
  'repertoire: the current position shows the updated line immediately');

// Saved while another tab had deleted the line: say so, not "it changed".
await savedLines.first().getByRole('button', { name: 'Edit this line' }).click();
await lineEditor.getByRole('heading', { name: 'Edit White line' }).waitFor();
await editName.fill('Deleted elsewhere');
await saveChanges.click();
await lineEditor.getByText('was deleted', { exact: false }).waitFor({ timeout: 5000 }).catch(() => {});
record('repertoire edit', /deleted in another tab/.test(await lineEditor.textContent()),
  'repertoire: saving a line deleted in another tab says it was deleted');
await lineEditor.getByRole('button', { name: 'Cancel' }).click();

// A long "nothing here" sentence wraps inside the explorer instead of
// running out of it ("…of each game; this p").
await open('https://lichess.org/ox-fixture/explorer-late');
if (!await page.evaluate(() => document.querySelector('.explorer-box').classList.contains('ox-mine'))) await page.click('.ox-tab');
await page.waitForFunction(() => !!document.querySelector('.ox-mine-content .ox-empty'), null, { timeout: 15000 }).catch(() => {});
{
  const empty = await page.evaluate(() => {
    const node = document.querySelector('.ox-mine-content .ox-empty');
    return node && { text: node.textContent, fits: node.scrollWidth <= node.clientWidth };
  });
  record('explorer', !!empty && /this position is later/.test(empty.text) && empty.fits,
    `explorer: a long empty-state sentence wraps inside the box (${empty ? `"${empty.text.slice(0, 40)}…", ${empty.fits ? 'fits' : 'cut off'}` : 'absent'})`);
}
await page.click('.explorer-title .button-link:not(.ox-tab)');
await page.waitForTimeout(400);

// The gear closes Lichess's explorer settings; with My games chosen on top of
// them, that must not leave My games.
await open('https://lichess.org/ox-fixture/explorer-settings');
if (!await page.evaluate(() => document.querySelector('.explorer-box').classList.contains('ox-mine'))) await page.click('.ox-tab');
await page.waitForTimeout(400);
await page.click('.explorer-title .toconf');
await page.waitForTimeout(400);
record('explorer', await page.evaluate(() => document.querySelector('.explorer-box').classList.contains('ox-mine')),
  "explorer: closing Lichess's settings keeps My games chosen");
await page.click('.explorer-title .button-link:not(.ox-tab)');
await page.waitForTimeout(400);

await open('https://lichess.org/ox-fixture/custom-start');
await page.waitForTimeout(1500);
record('custom start', await page.evaluate(() => globalThis.OX.currentLine() === null
  && !/save this line/i.test(document.querySelector('[data-ox-host=repertoire]')?.shadowRoot?.textContent || '')),
  'custom start: moves from a set-up position are not offered as a line to save');

await open('https://lichess.org/ox-fixture/study-set-up');
await page.waitForTimeout(1000);
record('study from a position', await page.evaluate(fen => globalThis.OX.state.position?.fen === fen
  && globalThis.OX.currentLine() === null, SETUP_FEN),
  "study from a set-up position: the position is Lichess's own, not the normal start");

// Annotate chapter: what it said about one chapter's publish must not stay
// on screen in the next chapter.
await context.route('https://lichess.org/study/oxFixt01', route =>
  route.fulfill({ status: 200, contentType: 'text/html', body: studyAnnotate }));
await context.route('https://lichess.org/analysis/publish', route => route.fulfill({ status: 200, body: '' }));
await open('https://lichess.org/study/oxFixt01');
{
  const bar = () => page.evaluate(() => document.querySelector('[data-ox-host=annotate]')?.shadowRoot?.querySelector('.ox')?.innerText || '');
  const shown = await bar();
  record('annotate', /2 of 2 moves/.test(shown), `annotate: a fully analysed chapter can be annotated ("${shown.split('\n')[0]}")`);
  await page.evaluate(() => [...document.querySelector('[data-ox-host=annotate]').shadowRoot.querySelectorAll('button')]
    .find(b => /annotate/i.test(b.textContent))?.click());
  await page.waitForTimeout(800);
  record('annotate', /Annotated/.test(await bar()), 'annotate: publishing says it was annotated');
  await page.evaluate(() => window.__oxNextChapter());
  await page.waitForTimeout(2000);
  record('annotate', !/Annotated/.test(await bar()), 'annotate: another chapter does not repeat the last chapter’s result');
}

await open('https://lichess.org/ox-fixture/explorer');
record('explorer', await page.evaluate(() => getComputedStyle(document.querySelector('.explorer-title .player')).display === 'none'),
  "explorer: Lichess's Player tab gives way to My games");
await open('https://lichess.org/ox-fixture/explorer-variant');
record('explorer', await page.evaluate(() => getComputedStyle(document.querySelector('.explorer-title .player')).display !== 'none'
  && !document.querySelector('.ox-tab')),
  "explorer: on a variant board (no My games) Lichess's Player tab stays");

// Behind the bot check, a local copy at the same address (so the page counts
// as an analysis board, where a missing feature is reported).
if (!realLichess) {
  await context.route('https://lichess.org/analysis/pgn/e4_e5', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: explorerPage }));
}
await open('https://lichess.org/analysis/pgn/e4_e5');
await page.evaluate(() => {
  const host = document.querySelector('[data-ox-host=repertoire]');
  if (host) host.after(host.cloneNode(false));
});
await page.waitForTimeout(800);
record('stray copy', (await hosts()).filter(host => host.id === 'repertoire').length === 1,
  'stray copy: a box the runner does not own is removed');

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

// Settings use a separate extension context in Chrome. Simulate only
// its message API so destructive controls are exercised on disposable data.
const settingsContext = await browser.newContext();
await settingsContext.addInitScript(() => {
  let accounts = [{ id: 1, platform: 'lichess', username: 'Fixture', games: 10 }];
  let offline = true;
  window.settingsWrites = 0;
  window.chrome.runtime = {
    async sendMessage({ method, path }) {
      if (offline) {
        offline = false;
        return { ok: false, offline: true };
      }
      if (method === 'DELETE') {
        window.settingsWrites++;
        accounts = [];
      }
      return { ok: true, data: { accounts, has_lichess_token: true } };
    },
  };
});
await settingsContext.route('https://settings.invalid/**', route => {
  const name = new URL(route.request().url()).pathname.slice(1);
  const contentType = { 'settings.html': 'text/html', 'settings.js': 'text/javascript', 'settings.css': 'text/css' }[name];
  return contentType ? route.fulfill({ status: 200, contentType, body: read(name) }) : route.abort();
});
const settingsPage = await settingsContext.newPage();
await settingsPage.goto('https://settings.invalid/settings.html');
await settingsPage.getByText('Local service is starting. Try again shortly.').waitFor();
await settingsPage.getByText('Connected to the local service').waitFor();
record('settings', await settingsPage.getByText('Connected to the local service').isVisible(),
  'settings: recovers from an offline service');
await settingsPage.getByLabel('Username').fill('bad/name');
await settingsPage.getByRole('button', { name: 'Add and import' }).click();
record('settings', await settingsPage.getByText('usernames can\'t contain spaces', { exact: false }).isVisible(),
  'settings: rejects an invalid username before importing');
await settingsPage.getByRole('button', { name: 'Remove', exact: true }).dblclick();
const confirm = settingsPage.getByRole('button', { name: 'Confirm deletion of Fixture and its imported games' });
record('settings', await confirm.isVisible() && await settingsPage.evaluate(() => window.settingsWrites) === 0,
  'settings: double-clicking Remove only arms the confirmation');
await settingsPage.getByRole('button', { name: 'Cancel', exact: true }).click();
await settingsPage.getByRole('button', { name: 'Remove', exact: true }).press('Enter');
await confirm.press('Enter');
await settingsPage.getByText('Fixture removed.').waitFor();
record('settings', await settingsPage.evaluate(() => window.settingsWrites) === 1,
  'settings: cancellation preserves the account and explicit keyboard confirmation removes it once');

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
