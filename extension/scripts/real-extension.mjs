#!/usr/bin/env node
// Runs the REAL extension (service worker, manifest, settings page and all) in
// a separate headless Chrome with a fresh profile, for what check.mjs and your
// own Chrome can't show: Lichess's narrower layouts, and the settings page.
//
//   node extension/scripts/real-extension.mjs
//
// It only reads. It is signed out of Lichess, so the opening explorer (and My
// games) can't be tested here, and Cloudflare blocks headless Chrome on game
// pages and /analysis/<fen>.
//
// The temporary extension talks only to the fixture server below. It must not
// send its idea of the live-game lock to the user's app. Screenshots go to
// extension/check-output/real-*.png.
// See extension/TESTING.md.
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, '..');
const { chromium } = createRequire(import.meta.url)('playwright');
const ID = 'jedkgjcnhhhbioonbcfiabgmeicodnfn'; // fixed by the manifest's key
const outDir = join(extensionDir, 'check-output');
mkdirSync(outDir, { recursive: true });
const checkNarrow = process.env.OX_CHECK_NARROW === '1';
const version = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8')).version;

let failures = 0;
const record = (ok, text) => { if (!ok) failures += 1; console.log(`${ok ? '  ok  ' : '  FAIL'} ${text}`); };

const healthReports = [];
let profileReads = 0;
let removed = 0;
let imported = 0;
let analysisGames = 0;
let syncStatus = 'running';
let cancelRequests = 0;
let checking = false;
const service = createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  const reply = (value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  switch (`${req.method} ${pathname}`) {
    case 'GET /api/profile':
      return reply({ has_lichess_token: false, accounts: [
        { id: 1, platform: 'lichess', username: 'FixtureSync', games: imported,
          sync_job: { id: 'sync-1', status: syncStatus, seen: ++profileReads, imported, cancel_requested: cancelRequests > 0 } },
        ...(removed ? [] : [{ id: 2, platform: 'chesscom', username: 'FixtureIdle', games: 0 }]),
      ] });
    case 'DELETE /api/accounts/2':
      removed += 1;
      return reply({ success: true });
    case 'DELETE /api/sync-jobs/sync-1':
      cancelRequests += 1;
      return reply({ id: 'sync-1', status: syncStatus, cancel_requested: true }, 202);
    case 'GET /api/analysis':
      return reply({ running: checking, total_games: analysisGames, unchecked: analysisGames, done: 0, total: analysisGames });
    case 'GET /api/repertoire/tree':
      return reply({ color: searchParams.get('color'), root: { children: [] }, branches: [] });
    case 'POST /api/extension/health': {
      let body = '';
      for await (const chunk of req) body += chunk;
      healthReports.push(JSON.parse(body));
      return reply({ ok: true });
    }
    case 'GET /api/extension/build':
      return reply({ build: 1 });
    case 'GET /api/lichess-engine':
      return reply({ state: 'off' });
    case 'GET /api/health':
    case 'POST /api/keepalive':
    case 'PUT /api/lichess-engine/paused':
      return reply({ ok: true });
    default:
      return reply({ detail: 'No fixture for this route' }, 404);
  }
});
await new Promise((resolve, reject) => {
  service.once('error', reject);
  service.listen(0, '127.0.0.1', resolve);
});
const fixturePort = service.address().port;
const sandbox = mkdtempSync(join(tmpdir(), 'ox-real-'));
const fixtureExtension = join(sandbox, 'extension');
let context;
try {
  mkdirSync(fixtureExtension);
  for (const name of ['src', 'vendor', 'icons', 'manifest.json', 'settings.html', 'settings.css', 'settings.js']) {
    cpSync(join(extensionDir, name), join(fixtureExtension, name), { recursive: true });
  }
  for (const name of ['manifest.json', 'src/background.js', 'settings.html']) {
    const path = join(fixtureExtension, name);
    const source = readFileSync(path, 'utf8');
    if (!source.includes('127.0.0.1:8001')) throw new Error(`Expected localhost address in ${name}`);
    writeFileSync(path, source.replaceAll('127.0.0.1:8001', `127.0.0.1:${fixturePort}`)
      .replace("'openings_app'", "'openings_test_fixture_only'"));
  }
  context = await chromium.launchPersistentContext(join(sandbox, 'profile'), {
    channel: 'chrome', headless: true, viewport: { width: 1440, height: 1000 },
    args: ['--enable-unsafe-extension-debugging'], ignoreDefaultArgs: ['--disable-extensions'],
  });
  // Branded Chrome ignores --load-extension; this is the call that works.
  const cdp = await context.browser().newBrowserCDPSession();
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: fixtureExtension });
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

  console.log('\nThe analysis board');
  const widths = [[1440, 1000], [1100, 900]];
  if (checkNarrow) widths.push([900, 900], [700, 900], [390, 800]);
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await page.goto('https://lichess.org/analysis/pgn/e4_e5_Nf3_Nc6', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(9500); // past the runner's 8 s grace: a missing feature would be reported by now
    const s = await state();
    const label = `${width}px (${s.columns} column${s.columns === '1' ? '' : 's'})`;
    record(s.repertoire > 0, `${label}: the repertoire is on the page (${s.repertoire}px high)`);
    record(s.overflow <= 0, `${label}: the page is no wider than the window (${s.overflow}px over)`);
    record(s.hosts.includes('engine') === s.engineBar, `${label}: the engine box is there exactly when Lichess's engine bar is`);
    if (s.beside) record(s.sideBelowBoard <= 2, `${label}: the left column ends with the board (${s.sideBelowBoard}px below)`);
    await page.screenshot({ path: join(outDir, `real-analysis-${width}.png`), fullPage: s.columns === '1' });
  }
  if (checkNarrow) {
    // The same page narrowed and widened without a reload.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(1500);
    const widened = await state();
    record(widened.columns === '3' && widened.repertoire > 0 && widened.hosts.includes('engine'),
      'widened again without a reload: everything is back in place');
  }

  const broken = new Set(healthReports.flatMap(report => Object.values(report.features)
    .filter(feature => ['missing', 'hidden', 'error'].includes(feature.status)).map(feature => feature.name)));
  record(healthReports.some(report => report.page_kind === 'analyse') && broken.size === 0,
    `analysis health reports reached the fixture without errors (${[...broken].join(', ') || 'none'})`);

  console.log('\nThe settings page');
  const settings = await context.newPage();
  settings.on('pageerror', error => errors.push(`settings: ${String(error).slice(0, 200)}`));
  await settings.goto(`chrome-extension://${ID}/settings.html`);
  await settings.waitForTimeout(2500);
  const text = (await settings.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  record(/Connected to the local service/.test(text), 'it reaches the app');
  record(/games are checked|No games|checked/.test(text), 'it says how many games are checked');
  await settings.screenshot({ path: join(outDir, 'real-settings.png'), fullPage: true });
  if (checkNarrow) {
    await settings.setViewportSize({ width: 390, height: 800 });
    await settings.waitForTimeout(500);
    record(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'it fits a phone-wide window');
    await settings.screenshot({ path: join(outDir, 'real-settings-390.png'), fullPage: true });
  }

  const idle = settings.locator('#accounts li').filter({ hasText: 'FixtureIdle' });
  const remove = idle.getByRole('button', { name: 'Remove', exact: true });
  const confirm = idle.getByRole('button', { name: 'Confirm deletion of FixtureIdle and its imported games' });
  await remove.dblclick();
  record(await confirm.isVisible() && removed === 0, 'double-clicking Remove only arms the confirmation');
  await idle.getByRole('button', { name: 'Cancel', exact: true }).click();
  await remove.focus();
  await settings.keyboard.press('Enter');
  const progress = await settings.locator('#accounts li').filter({ hasText: 'FixtureSync' }).innerText();
  await settings.waitForFunction(previous => {
    const row = [...document.querySelectorAll('#accounts li')].find(item => item.textContent.includes('FixtureSync'));
    return row && row.innerText !== previous;
  }, progress);
  const retained = await confirm.isVisible() && await confirm.evaluate(node => node === document.activeElement);
  record(retained && removed === 0, 'an account sync poll preserves the other account’s confirmation and keyboard focus');
  if (retained) {
    await settings.keyboard.press('Enter');
    await idle.waitFor({ state: 'detached' });
    record(removed === 1, 'confirming after the poll removes only the fixture account once');
  }

  analysisGames = 5;
  const analysisCount = settings.getByText(/0 of 5 games are checked/);
  const consistent = await analysisCount.waitFor({ timeout: 7500 }).then(() => true, () => false);
  record(consistent && await settings.locator('#check-all').isVisible(),
    'analysis counts stay consistent while the account profile still reports no imported games');

  imported = analysisGames;
  syncStatus = 'completed';
  const account = settings.locator('#accounts li').filter({ hasText: 'FixtureSync' });
  await account.getByText('5 games', { exact: true }).waitFor();
  const checkStateUpdated = await analysisCount.waitFor({ timeout: 4000 }).then(() => true, () => false);
  record(checkStateUpdated && await settings.locator('#check-all').isVisible(),
    'an import started elsewhere updates the count of unchecked games and enables Check all');

  // A sync reports completion before the worker has started its Stockfish run.
  checking = true;
  const checkStarted = await settings.locator('#check-stop').waitFor({ timeout: 7500 }).then(() => true, () => false);
  record(checkStarted, 'a delayed automatic check shows up even after the sync stopped polling');

  // A different tab can also start a new sync after the settings page was idle.
  syncStatus = 'running';
  const cancelSync = account.getByRole('button', { name: 'Cancel sync' });
  const syncStarted = await cancelSync
    .waitFor({ timeout: 7500 }).then(() => true, () => false);
  record(syncStarted, 'a new sync started elsewhere is picked up while settings is open');
  if (syncStarted) {
    await cancelSync.click();
    const cancelling = account.getByRole('button', { name: 'Cancelling…', exact: true });
    await cancelling.waitFor({ timeout: 4000 });
    record(await cancelling.isDisabled() && await account.getByRole('button', { name: 'Remove' }).isDisabled()
      && cancelRequests === 1 && await settings.getByText('Cancelling sync of FixtureSync…').isVisible(),
      'a running sync stays visibly pending and its controls stay disabled after cancellation is requested');
    syncStatus = 'cancelled';
    await settings.getByText('FixtureSync: sync cancelled.').waitFor({ timeout: 4000 });
    record(await account.getByRole('button', { name: 'Sync', exact: true }).isEnabled(),
      'settings confirms cancellation and enables Sync once the worker stops');
  }

  record(errors.length === 0, `no errors from the extension on any page (${errors.join(' | ') || 'none'})`);
} finally {
  // The persistent context owns this whole browser. Close the browser
  // directly so teardown doesn't depend on a separate context-close event.
  await context?.browser()?.close();
  await new Promise(resolve => service.close(resolve));
  rmSync(sandbox, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} problem(s) found.` : '\nThe real extension passed every check.');
process.exit(failures ? 1 : 0);
