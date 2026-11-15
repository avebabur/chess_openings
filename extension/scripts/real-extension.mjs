#!/usr/bin/env node
// Runs the REAL extension (service worker, manifest, settings page and all) in
// a separate headless Chrome with a fresh profile, for what check.mjs and your
// own Chrome can't show: Lichess's narrower layouts, and the settings page.
//
//   node extension/scripts/real-extension.mjs      (the app must be running on :8001)
//
// It only reads. It is signed out of Lichess, so the opening explorer (and My
// games) can't be tested here, and Cloudflare blocks headless Chrome on game
// pages and /analysis/<fen>.
//
// NEVER while a game is on: this second copy of the extension sees no game and
// would tell the app so. The script refuses to start while the app says the
// live-game lock is on. Screenshots go to extension/check-output/real-*.png.
// See extension/TESTING.md.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, '..');
const { chromium } = createRequire(import.meta.url)('playwright');
const BACKEND = 'http://127.0.0.1:8001';
const ID = 'jedkgjcnhhhbioonbcfiabgmeicodnfn'; // fixed by the manifest's key
const outDir = join(extensionDir, 'check-output');
mkdirSync(outDir, { recursive: true });
const version = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8')).version;

let failures = 0;
const record = (ok, text) => { if (!ok) failures += 1; console.log(`${ok ? '  ok  ' : '  FAIL'} ${text}`); };

const engine = await fetch(`${BACKEND}/api/lichess-engine`).then(r => r.json()).catch(() => null);
if (!engine) { console.error('The app is not running on :8001 (./start.sh, or open Lichess in Chrome).'); process.exit(1); }
if (engine.paused) {
  console.error('The live-game lock is on (a game is in progress in Chrome, or no Lichess tab is open in it yet). Not running.');
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'ox-real-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true, viewport: { width: 1440, height: 1000 },
  args: ['--enable-unsafe-extension-debugging'], ignoreDefaultArgs: ['--disable-extensions'],
});
try {
  // Branded Chrome ignores --load-extension; this is the call that works.
  const cdp = await context.browser().newBrowserCDPSession();
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: extensionDir });
  record(loaded.id === ID, `the extension loads under its fixed id (${loaded.id}), version ${version}`);

  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error).slice(0, 200)));
  page.on('console', message => { if (/\[openings\]/.test(message.text())) errors.push(message.text().slice(0, 200)); });

  const state = () => page.evaluate(() => {
    const height = id => Math.round(document.querySelector(`[data-ox-host=${id}]`)?.getBoundingClientRect().height || 0);
    const side = document.querySelector('aside.analyse__side')?.getBoundingClientRect();
    const board = document.querySelector('main.analyse .cg-wrap')?.getBoundingClientRect();
    return {
      columns: getComputedStyle(document.body).getPropertyValue('---display-columns').trim(),
      overflow: document.documentElement.scrollWidth - innerWidth,
      hosts: [...document.querySelectorAll('[data-ox-host]')].map(host => host.dataset.oxHost),
      repertoire: height('repertoire'),
      engineBar: !!document.querySelector('main.analyse .analyse__tools > .ceval'),
      beside: !!side && !!board && side.right <= board.left,
      sideBelowBoard: !!side && !!board ? Math.round(side.bottom - board.bottom) : 0,
    };
  });

  console.log('\nThe analysis board at each of Lichess\'s layouts');
  for (const [width, height] of [[1440, 1000], [1100, 900], [900, 900], [700, 900], [390, 800]]) {
    await page.setViewportSize({ width, height });
    await page.goto('https://lichess.org/analysis/pgn/e4_e5_Nf3_Nc6', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(9500); // past the runner's 8 s grace: a missing feature would be reported by now
    const s = await state();
    const label = `${width}px (${s.columns} column${s.columns === '1' ? '' : 's'})`;
    record(s.repertoire > 0, `${label}: the repertoire is on the page (${s.repertoire}px high)`);
    record(s.overflow <= 0, `${label}: the page is no wider than the window (${s.overflow}px over)`);
    record(s.hosts.includes('engine') === s.engineBar, `${label}: the engine box is there exactly when Lichess's engine bar is`);
    if (s.beside) record(s.sideBelowBoard <= 2, `${label}: the left column ends with the board (${s.sideBelowBoard}px below)`);
    await page.screenshot({ path: join(outDir, `real-analysis-${width}.png`) });
  }
  // The same page narrowed and widened without a reload.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(1500);
  const widened = await state();
  record(widened.columns === '3' && widened.repertoire > 0 && widened.hosts.includes('engine'),
    'widened again without a reload: everything is back in place');

  const report = JSON.parse(readFileSync(join(extensionDir, 'health-report.json'), 'utf8'));
  record(report.broken.length === 0, `nothing was reported broken at any width (${report.broken.map(b => b.feature).join(', ') || 'none'})`);

  console.log('\nThe settings page');
  const settings = await context.newPage();
  settings.on('pageerror', error => errors.push(`settings: ${String(error).slice(0, 200)}`));
  await settings.goto(`chrome-extension://${ID}/settings.html`);
  await settings.waitForTimeout(2500);
  const text = (await settings.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  record(/Connected to the local service/.test(text), 'it reaches the app');
  record(/games are checked|No games|checked/.test(text), 'it says how many games are checked');
  await settings.screenshot({ path: join(outDir, 'real-settings.png'), fullPage: true });
  await settings.setViewportSize({ width: 390, height: 800 });
  await settings.waitForTimeout(500);
  record(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'it fits a phone-wide window');
  await settings.screenshot({ path: join(outDir, 'real-settings-390.png'), fullPage: true });

  record(errors.length === 0, `no errors from the extension on any page (${errors.join(' | ') || 'none'})`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} problem(s) found.` : '\nThe real extension held at every width.');
process.exit(failures ? 1 : 0);
