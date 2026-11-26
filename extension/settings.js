// Extension-owned settings. The Lichess page never receives account credentials
// or the API token; requests go through the extension background worker.
const $ = id => document.getElementById(id);
const connection = $('connection');
const accountsList = $('accounts');
let profile = null;
let refreshTimer = null;
let profileRequest = 0;
const accountRows = new Map();
const IDLE_POLL_MS = 5000;
// A Lichess tab can start a sync while settings is open.
// The service keeps working without these polls when settings is hidden.
function pollWhileVisible(poll, delay) {
  if (document.hidden) return null;
  return setTimeout(() => { if (!document.hidden) poll(); }, delay);
}
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
  control.addEventListener('keydown', event => {
    if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
  });
  control.addEventListener('click', async event => {
    // A double-click on Remove should only open the confirmation, even if
    // the newly displayed Cancel button ends up under the pointer.
    if (event.detail > 1) return;
    if (!timer) {
      control.textContent = armed;
      control.setAttribute('aria-label', typeof label === 'function' ? label() : label);
      cancel = button('Cancel', event => { if (event.detail < 2) disarm(); }, 'quiet');
      control.after(cancel);
      timer = setTimeout(disarm, ARMED_MS);
      return;
    }
    disarm();
    await run();
  });
  return disarm;
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
const syncing = account => ['queued', 'running'].includes(account.sync_job?.status);

// What the account's last sync did, for its row.
function syncLine(account) {
  const job = account.sync_job;
  if (!job) return 'Not synced yet';
  if (syncing(account) && job.cancel_requested) return 'Cancelling sync…';
  if (job.status === 'queued') return 'Sync waiting to start…';
  if (job.status === 'running') return `Syncing… ${job.seen || 0} looked at, ${job.imported || 0} new`;
  if (job.status === 'failed') return `Last sync failed ${ago(job.finished_at)}: ${job.error || 'unknown error'}`;
  if (job.status === 'cancelled') return `Last sync cancelled ${ago(job.finished_at)}`;
  const warnings = job.warnings || [];
  return `Synced ${ago(job.finished_at)}: ${newGames(job.imported)}`
    + (warnings.length ? `. ${warnings.length} warning${warnings.length === 1 ? '' : 's'}: ${warnings[0]}` : '');
}

function accountRow() {
  const item = document.createElement('li');
  let account;
  let busy = false;
  const info = document.createElement('div');
  const name = document.createElement('span');
  name.className = 'account-name';
  const badge = document.createElement('span');
  badge.className = 'account-badge';
  const user = document.createElement('span');
  name.append(badge, user);
  const meta = document.createElement('span');
  meta.className = 'account-meta';
  const synced = document.createElement('span');
  synced.className = 'account-meta';
  info.append(name, meta, synced);
  const actions = document.createElement('div');
  actions.className = 'account-actions';
  const running = () => syncing(account);
  const sync = button('Sync', async () => {
    const { id, username, sync_job: job } = account;
    busy = true;
    disarmRemove();
    updateActions();
    try {
      if (running()) {
        const requested = await api('DELETE', `/sync-jobs/${job.id}`);
        if (account.sync_job?.id === job.id && running()) update({ ...account, sync_job: requested });
        if (requested.status === 'cancelled') {
          watching.delete(id);
          message('account-message', `Sync of ${username} cancelled.`);
        } else {
          watching.set(id, { job: job.id, name: username });
          message('account-message', `Cancelling sync of ${username}…`);
        }
      } else {
        const started = await api('POST', `/accounts/${id}/sync`);
        watching.set(id, { job: started.id, name: username });
        message('account-message', `Syncing ${username}…`);
      }
      await load();
    } catch (error) { message('account-message', error.message, true); }
    finally { busy = false; updateActions(); }
  }, 'quiet');
  actions.append(sync);
  const remove = button('', null, 'danger');
  const disarmRemove = confirmable(remove, {
    idle: 'Remove',
    armed: 'Delete account and imported games?',
    label: () => `Confirm deletion of ${account.username} and its imported games`,
    run: async () => {
      busy = true;
      updateActions();
      try {
        await api('DELETE', `/accounts/${account.id}`);
        message('account-message', `${account.username} removed.`);
        await load();
      } catch (error) { message('account-message', error.message, true); }
      finally { busy = false; updateActions(); }
    },
  });
  actions.append(remove);
  item.append(info, actions);
  function updateActions() {
    const active = running();
    const cancelling = active && account.sync_job.cancel_requested;
    const label = cancelling ? 'Cancelling…' : active ? 'Cancel sync' : 'Sync';
    if (sync.textContent !== label) sync.textContent = label;
    sync.disabled = busy || cancelling;
    remove.disabled = active || busy;
    if (active && remove.hasAttribute('aria-label')) disarmRemove();
  }
  function update(next) {
    account = next;
    const job = account.sync_job;
    badge.textContent = account.platform === 'lichess' ? 'Lichess' : 'Chess.com';
    user.textContent = account.username;
    meta.textContent = `${Number(account.games || 0).toLocaleString()} games`;
    synced.textContent = syncLine(account);
    if (job?.status === 'failed' || job?.warnings?.length) synced.dataset.error = 'true';
    else delete synced.dataset.error;
    updateActions();
  }
  return { item, update, disarm: disarmRemove };
}

const noAccounts = document.createElement('li');
noAccounts.textContent = 'No accounts yet. Add one below.';

function renderAccounts() {
  const accounts = profile?.accounts || [];
  const present = new Set(accounts.map(account => account.id));
  for (const [id, row] of accountRows) {
    if (present.has(id)) continue;
    row.disarm();
    row.item.remove();
    accountRows.delete(id);
  }
  if (!accounts.length) {
    if (!noAccounts.isConnected) accountsList.append(noAccounts);
    return;
  }
  noAccounts.remove();
  // The poll updates progress without removing a focused control or an open
  // confirmation in another row.
  let prior = null;
  for (const account of accounts) {
    if (!accountRows.has(account.id)) accountRows.set(account.id, accountRow());
    const row = accountRows.get(account.id);
    row.update(account);
    const next = prior ? prior.nextElementSibling : accountsList.firstElementChild;
    if (row.item !== next) accountsList.insertBefore(row.item, next);
    prior = row.item;
  }
}

// Says how each sync started here ended, once it has.
function reportFinishedSyncs() {
  for (const [id, { job, name }] of watching) {
    const account = profile.accounts.find(a => a.id === id);
    const latest = account?.sync_job;
    if (!account) { watching.delete(id); continue; }
    if (!latest || latest.id !== job || syncing(account)) continue;
    watching.delete(id);
    if (latest.status === 'failed') message('account-message', `${name}: the sync failed. ${latest.error || ''}`, true);
    else if (latest.status === 'cancelled') message('account-message', `${name}: sync cancelled.`);
    else message('account-message', `${name}: ${newGames(latest.imported)}${latest.imported ? ' synced' : ''}.`, Boolean(latest.warnings?.length));
  }
}

function renderToken() {
  const hasToken = Boolean(profile?.has_lichess_token);
  $('token-state').textContent = hasToken ? 'Token saved locally.' : 'No token saved. Your local Stockfish needs a Lichess token with engine access.';
  $('remove-token').hidden = !hasToken;
}

async function load() {
  clearTimeout(refreshTimer);
  const request = ++profileRequest;
  try {
    const next = await api('GET', '/profile');
    if (request !== profileRequest) return;
    profile = next;
    connection.textContent = 'Connected to the local service';
    delete connection.dataset.error;
    renderAccounts();
    renderToken();
    reportFinishedSyncs();
    refreshTimer = pollWhileVisible(load, profile.accounts.some(syncing) ? 1800 : IDLE_POLL_MS);
  } catch (error) {
    if (request !== profileRequest) return;
    connection.textContent = error.message;
    connection.dataset.error = 'true';
    refreshTimer = pollWhileVisible(load, 2000);
  }
}

$('refresh').addEventListener('click', () => load());
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
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

load();
