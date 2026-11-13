// Extension-owned settings. The Lichess page never receives account credentials
// or the API token; requests go through the extension background worker.
const $ = id => document.getElementById(id);
const connection = $('connection');
const accountsList = $('accounts');
let profile = null;
let refreshTimer = null;

async function api(method, path, body) {
  const response = await chrome.runtime.sendMessage({ type: 'ox-api', method, path, body });
  if (!response?.ok) {
    const detail = response?.data?.detail;
    throw new Error(typeof detail === 'string' ? detail : response?.offline ? 'Local service is starting. Try again shortly.' : `Request failed (${response?.status || 'offline'}).`);
  }
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
    meta.textContent = `${Number(account.games || 0).toLocaleString()} games${running ? ` · ${job.status} · ${job.imported || 0} new` : job?.status === 'failed' ? ` · sync failed: ${job.error || 'unknown error'}` : ''}`;
    info.append(name, meta);
    const actions = document.createElement('div');
    actions.className = 'account-actions';
    const sync = button(running ? 'Cancel sync' : 'Sync', async () => {
      sync.disabled = true;
      try {
        if (running) await api('DELETE', `/sync-jobs/${job.id}`);
        else await api('POST', `/accounts/${account.id}/sync`);
        message('account-message', running ? 'Sync cancelled.' : 'Sync started.');
        await load();
      } catch (error) { message('account-message', error.message, true); }
      finally { sync.disabled = false; }
    }, 'quiet');
    actions.append(sync);
    let confirming = false;
    const remove = button('Remove', async () => {
      if (!confirming) {
        confirming = true;
        remove.textContent = 'Delete account and imported games?';
        remove.setAttribute('aria-label', `Confirm deletion of ${account.username} and its imported games`);
        return;
      }
      remove.disabled = true;
      try {
        await api('DELETE', `/accounts/${account.id}`);
        message('account-message', `${account.username} removed.`);
        await load();
      } catch (error) { message('account-message', error.message, true); remove.disabled = false; }
    }, 'danger');
    remove.disabled = running;
    actions.append(remove);
    item.append(info, actions);
    accountsList.append(item);
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

$('refresh').addEventListener('click', load);
$('add-account').addEventListener('submit', async event => {
  event.preventDefault();
  const username = $('username').value.trim();
  if (!username) return;
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await api('POST', '/accounts', { platform: $('platform').value, username });
    $('username').value = '';
    message('account-message', `${username} added. Import started.`);
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

$('remove-token').addEventListener('click', async event => {
  const control = event.currentTarget;
  if (control.dataset.confirm !== 'true') {
    control.dataset.confirm = 'true';
    control.textContent = 'Confirm token removal';
    return;
  }
  control.disabled = true;
  try {
    await api('PUT', '/settings/lichess-token', { token: '' });
    message('token-message', 'Token removed.');
    await load();
  } catch (error) { message('token-message', error.message, true); }
  finally { control.disabled = false; control.textContent = 'Remove saved token'; delete control.dataset.confirm; }
});

load();
