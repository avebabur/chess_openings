#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/features/game.js'), 'utf8');

async function syncWith(replies) {
  const requests = [];
  const calls = new Map();
  const OX = {
    defineFeature() {},
    bridge: {
      async api(method, path) {
        const key = `${method} ${path}`;
        requests.push(key);
        const choices = replies[key];
        const index = calls.get(key) || 0;
        calls.set(key, index + 1);
        const reply = choices?.sequence ? choices.sequence[Math.min(index, choices.sequence.length - 1)] : choices;
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
  const context = vm.createContext({ OX, globalThis: { OX }, setTimeout: callback => queueMicrotask(callback), clearTimeout, Date, URLSearchParams });
  vm.runInContext(source, context, { filename: 'game.js' });
  return { result: await OX.syncGames(), text: OX.syncedText, requests };
}

const accounts = [
  { id: 1, username: 'whitePlayer' },
  { id: 2, username: 'blackPlayer' },
];

const partial = await syncWith({
  'GET /accounts': accounts,
  'POST /accounts/1/sync': { status: 'completed', imported: 3 },
  'POST /accounts/2/sync': { status: 'failed', error: 'rate limited' },
});
assert.equal(partial.result.count, 3);
assert.deepEqual([...partial.result.failures], ['blackPlayer: rate limited']);
assert.match(partial.text(partial.result), /3 new games synced/);
assert.match(partial.text(partial.result), /blackPlayer.*rate limited/);

const rejected = await syncWith({
  'GET /accounts': accounts,
  'POST /accounts/1/sync': { status: 'completed', imported: 2 },
  'POST /accounts/2/sync': new Error('service unavailable'),
});
assert.equal(rejected.result.count, 2);
assert.deepEqual([...rejected.result.failures], ['blackPlayer: service unavailable']);

const allDone = await syncWith({
  'GET /accounts': accounts,
  'POST /accounts/1/sync': { status: 'completed', imported: 0 },
  'POST /accounts/2/sync': { status: 'completed', imported: 0 },
});
assert.equal(allDone.text(allDone.result), 'Up to date: no new games');

const warned = await syncWith({
  'GET /accounts': accounts,
  'POST /accounts/1/sync': { status: 'warning', imported: 1, warnings: ['one game was skipped'] },
  'POST /accounts/2/sync': { status: 'completed', imported: 0 },
});
assert.match(warned.text(warned.result), /1 new game synced.*whitePlayer: one game was skipped/);

const allFailed = await syncWith({
  'GET /accounts': accounts,
  'POST /accounts/1/sync': { status: 'failed', imported: 0, error: 'timeout' },
  'POST /accounts/2/sync': { status: 'cancelled', imported: 0 },
});
assert.match(allFailed.text(allFailed.result), /^No new games synced\. 2 accounts failed:/);

const pollFailed = await syncWith({
  'GET /accounts': accounts,
  'POST /accounts/1/sync': { id: 'job1', status: 'queued', imported: 0 },
  'POST /accounts/2/sync': { status: 'completed', imported: 1 },
  'GET /sync-jobs/job1': new Error('poll failed'),
});
assert.equal(pollFailed.result.count, 1);
assert.deepEqual([...pollFailed.result.failures], ['whitePlayer: poll failed']);
assert.equal(pollFailed.requests.filter(request => request === 'GET /sync-jobs/job1').length, 3);

const transientPoll = await syncWith({
  'GET /accounts': accounts,
  'POST /accounts/1/sync': { id: 'job1', status: 'queued', imported: 0 },
  'POST /accounts/2/sync': { status: 'completed', imported: 1 },
  'GET /sync-jobs/job1': { sequence: [new Error('temporary network error'), { id: 'job1', status: 'completed', imported: 2 }] },
});
assert.equal(transientPoll.result.count, 3, 'a transient poll error must not lose a completed sync');
assert.deepEqual([...transientPoll.result.failures], []);
assert.equal(transientPoll.requests.filter(request => request === 'GET /sync-jobs/job1').length, 2);

console.log('Sync result checks passed.');
