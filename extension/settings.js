// Extension-owned settings. The Lichess page never receives account credentials
// or the API token; requests go through the extension background worker.
const $ = id => document.getElementById(id);
const connection = $('connection');
const accountsList = $('accounts');
let profile = null;
let refreshTimer = null;
// Syncs started from this page, so their result can be said when they end:
// account id -> { job, name }.
const watching = new Map();

// What the app says is wrong with a request, in words. FastAPI reports a
// field it rejected as a list of { loc, msg }, which used to show as
// "Request failed (422)".
function problem(response) {
  const detail = response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0] || {};
    const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : '';
    if (field === 'username') return "That isn't a username: usernames can't contain spaces or “/”.";
    return [field, first.msg].filter(Boolean).join(': ') || 'The app did not accept that.';
  }
  if (response?.offline) return 'Local service is starting. Try again shortly.';
  return `Request failed (${response?.status || 'offline'}).`;
}

async function api(method, path, body) {
  const response = await chrome.runtime.sendMessage({ type: 'ox-api', method, path, body });
  if (!response?.ok) throw new Error(problem(response));
  return response.data;
}

function message(id, text, error = false) {
  const node = $(id);
  node.textContent = text;
  if (error) node.dataset.error = 'true'; else delete node.dataset.error;
}

function button(label, action, className = '') {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.className = className;
  node.addEventListener('click', action);
  return node;
}

// A button that asks once more before doing something that can't be undone:
// the first click arms it and puts a Cancel next to it; it goes back by itself
// after a few seconds. `run` happens only on the second click.
const ARMED_MS = 8000;
function confirmable(control, { idle, armed, label, run }) {
  let timer = null;
  let cancel = null;
  const disarm = () => {
    clearTimeout(timer);
    timer = null;
    cancel?.remove();
    cancel = null;
    control.textContent = idle;
    control.removeAttribute('aria-label');
  };
  control.textContent = idle;
  control.addEventListener('click', async () => {
    if (!timer) {
      control.textContent = armed;
      control.setAttribute('aria-label', label);
      cancel = button('Cancel', disarm, 'quiet');
      control.after(cancel);
      timer = setTimeout(disarm, ARMED_MS);
      return;
    }
    disarm();
    await run();
  });
}

// "5 min ago" for one of the app's times ("2026-11-13 23:08:11", in UTC).
function ago(stamp) {
  if (!stamp) return '';
  const then = new Date(`${String(stamp).replace(' ', 'T')}Z`);
  const minutes = Math.round((Date.now() - then.getTime()) / 60000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return then.toLocaleDateString();
}

const newGames = count => (count ? `${count} new game${count === 1 ? '' : 's'}` : 'up to date, no new games');

// What the account's last sync did, for its row.
function syncLine(account) {
  const job = account.sync_job;
  if (!job) return 'Not synced yet';
  if (job.status === 'queued') return 'Sync waiting to start…';
  if (job.status === 'running') return `Syncing… ${job.seen || 0} looked at, ${job.imported || 0} new`;
  if (job.status === 'failed') return `Last sync failed ${ago(job.finished_at)}: ${job.error || 'unknown error'}`;
  if (job.status === 'cancelled') return `Last sync cancelled ${ago(job.finished_at)}`;
  const warnings = job.warnings || [];
  return `Synced ${ago(job.finished_at)}: ${newGames(job.imported)}`
    + (warnings.length ? `. ${warnings.length} warning${warnings.length === 1 ? '' : 's'}: ${warnings[0]}` : '');
}

function renderAccounts() {
  accountsList.replaceChildren();
  const accounts = profile?.accounts || [];
  if (!accounts.length) {
    const item = document.createElement('li');
    item.textContent = 'No accounts yet. Add one below.';
    accountsList.append(item);
  }
  for (const account of accounts) {
    const item = document.createElement('li');
    const info = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'account-name';
    const badge = document.createElement('span');
    badge.className = 'account-badge';
    badge.textContent = account.platform === 'lichess' ? 'Lichess' : 'Chess.com';
    const user = document.createElement('span');
    user.textContent = account.username;
    name.append(badge, user);
    const meta = document.createElement('span');
    meta.className = 'account-meta';
    const job = account.sync_job;
    const running = job && ['queued', 'running'].includes(job.status);
    meta.textContent = `${Number(account.games || 0).toLocaleString()} games`;
    const synced = document.createElement('span');
    synced.className = 'account-meta';
    synced.textContent = syncLine(account);
    if (job?.status === 'failed' || job?.warnings?.length) synced.dataset.error = 'true';
    info.append(name, meta, synced);
    const actions = document.createElement('div');
    actions.className = 'account-actions';
    const sync = button(running ? 'Cancel sync' : 'Sync', async () => {
      sync.disabled = true;
      try {
        if (running) {
          await api('DELETE', `/sync-jobs/${job.id}`);
          watching.delete(account.id);
          message('account-message', `Sync of ${account.username} cancelled.`);
        } else {
          const started = await api('POST', `/accounts/${account.id}/sync`);
          watching.set(account.id, { job: started.id, name: account.username });
          message('account-message', `Syncing ${account.username}…`);
        }
        await load();
      } catch (error) { message('account-message', error.message, true); }
      finally { sync.disabled = false; }
    }, 'quiet');
    actions.append(sync);
    const remove = button('', null, 'danger');
    confirmable(remove, {
      idle: 'Remove',
      armed: 'Delete account and imported games?',
      label: `Confirm deletion of ${account.username} and its imported games`,
      run: async () => {
        remove.disabled = true;
        try {
          await api('DELETE', `/accounts/${account.id}`);
          message('account-message', `${account.username} removed.`);
          await load();
        } catch (error) { message('account-message', error.message, true); remove.disabled = false; }
      },
    });
    remove.disabled = running;
    actions.append(remove);
    item.append(info, actions);
    accountsList.append(item);
  }
}

// Says how each sync started here ended, once it has.
function reportFinishedSyncs() {
  for (const [id, { job, name }] of watching) {
    const account = profile.accounts.find(a => a.id === id);
    const latest = account?.sync_job;
    if (!account) { watching.delete(id); continue; }
    if (!latest || latest.id !== job || ['queued', 'running'].includes(latest.status)) continue;
    watching.delete(id);
    if (latest.status === 'failed') message('account-message', `${name}: the sync failed. ${latest.error || ''}`, true);
    else if (latest.status === 'cancelled') message('account-message', `${name}: sync cancelled.`);
    else message('account-message', `${name}: ${newGames(latest.imported)}${latest.imported ? ' synced' : ''}.`, Boolean(latest.warnings?.length));
    loadChecks();
  }
}

function renderToken() {
  const hasToken = Boolean(profile?.has_lichess_token);
  $('token-state').textContent = hasToken ? 'Token saved locally.' : 'No token saved. Your local Stockfish needs a Lichess token with engine access.';
  $('remove-token').hidden = !hasToken;
}

async function load() {
  try {
    profile = await api('GET', '/profile');
    connection.textContent = 'Connected to the local service';
    delete connection.dataset.error;
    renderAccounts();
    renderToken();
    reportFinishedSyncs();
    const active = profile.accounts.some(a => ['queued', 'running'].includes(a.sync_job?.status));
    clearTimeout(refreshTimer);
    if (active) refreshTimer = setTimeout(load, 1800);
  } catch (error) {
    connection.textContent = error.message;
    connection.dataset.error = 'true';
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(load, 2000);
  }
}

// ---- checking games for mistakes ------------------------------------------
const duration = seconds => {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
};
const GUESS_SECONDS_A_GAME = 20; // until this run has checked a few itself
let checkTimer = null;
let checkRun = null; // { since, doneThen } of the run being watched

async function loadChecks() {
  clearTimeout(checkTimer);
  let status;
  try { status = await api('GET', '/analysis'); } catch { checkTimer = setTimeout(loadChecks, 3000); return; }
  const total = (profile?.accounts || []).reduce((n, a) => n + (a.games || 0), 0);
  const left = status.unchecked;
  $('check-all').hidden = status.running || !left;
  $('check-stop').hidden = !status.running;
  if (status.running) {
    if (!checkRun) checkRun = { since: Date.now(), doneThen: status.done };
    const done = status.done - checkRun.doneThen;
    const each = done >= 2 ? (Date.now() - checkRun.since) / 1000 / done : GUESS_SECONDS_A_GAME;
    const move = status.moves_total ? `, move ${Math.min(status.moves_done + 1, status.moves_total)} of ${status.moves_total}` : '';
    $('check-state').textContent = `Checking game ${Math.min(status.done + 1, status.total)} of ${status.total}`
      + `${status.title ? ` (${status.title}${move})` : ''}. About ${duration((status.total - status.done) * each)} left.`;
    checkTimer = setTimeout(loadChecks, 1500);
    return;
  }
  checkRun = null;
  if (status.error) message('check-message', status.error, true);
  $('check-state').textContent = !total ? 'No games imported yet.'
    : left ? `${(total - left).toLocaleString()} of ${total.toLocaleString()} games are checked. ${left.toLocaleString()} left: roughly ${duration(left * GUESS_SECONDS_A_GAME)} with your Stockfish.`
      : `All ${total.toLocaleString()} games are checked.`;
}

$('check-all').addEventListener('click', async () => {
  $('check-all').disabled = true;
  try {
    await api('POST', '/analysis', { all: true });
    message('check-message', 'Keep this page or a Lichess tab open while it runs. Games already checked are kept if it stops.');
  } catch (error) { message('check-message', error.message, true); }
  finally { $('check-all').disabled = false; }
  loadChecks();
});
$('check-stop').addEventListener('click', async () => {
  try {
    await api('DELETE', '/analysis');
    message('check-message', 'Stopped. The games checked so far are kept.');
  } catch (error) { message('check-message', error.message, true); }
  setTimeout(loadChecks, 1200);
});

$('refresh').addEventListener('click', () => { load().then(loadChecks); });
$('add-account').addEventListener('submit', async event => {
  event.preventDefault();
  const username = $('username').value.trim();
  if (!username) return;
  if (/[\s/]/.test(username)) {
    message('account-message', "That isn't a username: usernames can't contain spaces or “/”.", true);
    return;
  }
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const added = await api('POST', '/accounts', { platform: $('platform').value, username });
    $('username').value = '';
    if (added?.account && added?.job) watching.set(added.account.id, { job: added.job.id, name: username });
    message('account-message', `${username} added. Importing its games…`);
    await load();
  } catch (error) { message('account-message', error.message, true); }
  finally { submit.disabled = false; }
});

$('token-form').addEventListener('submit', async event => {
  event.preventDefault();
  const token = $('token').value.trim();
  if (!token) return;
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await api('PUT', '/settings/lichess-token', { token });
    $('token').value = '';
    message('token-message', 'Token saved. Lichess engine connection will update shortly.');
    await load();
  } catch (error) { message('token-message', error.message, true); }
  finally { submit.disabled = false; }
});

confirmable($('remove-token'), {
  idle: 'Remove saved token',
  armed: 'Confirm token removal',
  label: 'Confirm removal of the saved Lichess token',
  run: async () => {
    const control = $('remove-token');
    control.disabled = true;
    try {
      await api('PUT', '/settings/lichess-token', { token: '' });
      message('token-message', 'Token removed.');
      await load();
    } catch (error) { message('token-message', error.message, true); }
    finally { control.disabled = false; }
  },
});

load().then(loadChecks);
