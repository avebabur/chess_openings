// The content script's line to the background script. scripts/check.mjs swaps
// in its own bridge with the same shape, so the features run unchanged there.
(() => {
  const OX = (globalThis.OX = globalThis.OX || {});
  const ext = chrome;
  // After the extension reloads (an update), this copy is cut off: every call
  // would throw "Extension context invalidated". alive() lets core.js notice
  // and step aside; the new copy is put into the tab by the background script.
  const alive = () => { try { return Boolean(ext.runtime && ext.runtime.id); } catch { return false; } };
  const send = message => {
    if (!alive()) return Promise.reject(new Error('extension reloaded'));
    try { return ext.runtime.sendMessage(message); } catch (error) { return Promise.reject(error); }
  };

  OX.bridge = {
    alive,
    version: ext.runtime.getManifest().version,

    async api(method, path, body) {
      const res = await send({ type: 'ox-api', method, path, body });
      if (!res?.ok) {
        const error = new Error(res?.offline ? 'offline' : `HTTP ${res?.status}`);
        error.offline = !!res?.offline;
        error.autostart = res?.autostart;
        error.status = res?.status;
        throw error;
      }
      return res.data;
    },

    report(report) { send({ type: 'ox-health', report }).catch(() => {}); },
    openSettings() { return send({ type: 'ox-open-settings' }); },
    setPlaying(playing) { return send({ type: 'ox-playing', playing }).catch(() => null); },
    status() { return send({ type: 'ox-status' }); },
    onPaused(callback) {
      ext.runtime.onMessage.addListener(msg => { if (msg?.type === 'ox-paused') callback(msg.paused); });
    },
    // Storage throws too once this copy is cut off.
    async loadSettings() {
      if (!alive()) return {};
      const { settings = {} } = await ext.storage.local.get('settings');
      return settings;
    },
    saveSettings(settings) { return alive() ? ext.storage.local.set({ settings }).catch(() => {}) : Promise.resolve(); },
  };
})();
