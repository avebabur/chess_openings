// Carries Lichess's analysis requests from the page (page-bridge.js, in the
// page's own world) to the background script, which asks the app on this
// computer, and the app's lines back. lichess.org's page may not reach the app
// itself. Runs at document_start, before Lichess's first request.
//
// The page sends an "ox-engine" event ({op: "analyse" | "abort", id, …}); this
// script takes an "analyse" by setting <html data-ox-engine-ack> to its id
// synchronously (no ack: the page asks Lichess's engine service instead), then
// answers with "ox-engine-reply" events: start, chunk…, end, or unavailable /
// error. Closing the port aborts the app's request, which stops Stockfish.
(() => {
  const ext = chrome;
  // A copy cut off by an extension update stays silent, so the page falls
  // back (or the new copy, put in by the background script, answers).
  const alive = () => { try { return Boolean(ext.runtime && ext.runtime.id); } catch { return false; } };
  const ports = new Map();
  const reply = message => document.dispatchEvent(new CustomEvent('ox-engine-reply', { detail: JSON.stringify(message) }));

  function handle(event) {
    let ask = null;
    try { ask = JSON.parse(event.detail); } catch { return; }
    if (!ask || typeof ask.id !== 'string') return;
    const { id } = ask;
    if (ask.op === 'abort') {
      const port = ports.get(id);
      if (port) { ports.delete(id); try { port.disconnect(); } catch { /* already gone */ } }
      return;
    }
    if (ask.op !== 'analyse' || ports.has(id) || !alive()) return;
    let port;
    try { port = ext.runtime.connect({ name: 'ox-engine' }); } catch { return; }
    ports.set(id, port);
    document.documentElement.setAttribute('data-ox-engine-ack', id);
    port.onMessage.addListener(message => {
      if (!ports.has(id) || !message || typeof message.kind !== 'string') return;
      const last = message.kind !== 'start' && message.kind !== 'chunk';
      if (last) { ports.delete(id); try { port.disconnect(); } catch { /* already gone */ } }
      reply({ id, kind: message.kind, text: typeof message.text === 'string' ? message.text : undefined });
    });
    // The background script went away (Chrome stopped it, the extension
    // was updated) before the end: the page hears it as a failed request.
    port.onDisconnect.addListener(() => { if (ports.delete(id)) reply({ id, kind: 'error' }); });
    try { port.postMessage({ engineId: ask.engineId, work: ask.work }); } catch {
      ports.delete(id);
      reply({ id, kind: 'unavailable' });
    }
  }

  if (globalThis.__oxEngineRelay) document.removeEventListener('ox-engine', globalThis.__oxEngineRelay);
  globalThis.__oxEngineRelay = handle;
  document.addEventListener('ox-engine', handle);
})();
