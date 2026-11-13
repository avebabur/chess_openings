// Starts the extension on a lichess.org page.
(async () => {
  const OX = globalThis.OX;
  try {
    OX.settings = { ...OX.defaultSettings, ...(await OX.bridge.loadSettings()) };
  } catch { /* defaults */ }
  try {
    const status = await OX.bridge.status();
    OX.state.paused = !!status?.paused;
    if (status?.autostart) OX.state.autostart = status.autostart;
  } catch { /* background not ready: stay with defaults */ }
  OX.bridge.onPaused(paused => { OX.state.paused = paused; OX.runner.tick(); });
  const api = OX.bridge.api.bind(OX.bridge);
  OX.bridge.api = async (...args) => {
    try {
      return await api(...args);
    } catch (error) {
      if (error.offline) {
        OX.state.offline = true;
        if (error.autostart) OX.state.autostart = error.autostart;
      }
      throw error;
    }
  };
  OX.runner.start();
})();
