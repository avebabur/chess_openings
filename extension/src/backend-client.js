// Talks to the openings app's backend. Used by the background script (and by
// the check script), never by the page itself: lichess.org's page may not call
// a local server directly.
globalThis.OX_createBackendClient = function createBackendClient(base) {
  async function api(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty or not JSON */ }
    return { ok: res.ok, status: res.status, data };
  }

  return { api };
};
