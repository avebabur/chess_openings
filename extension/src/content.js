// Starts the extension on a lichess.org page.
(async () => {
  const OX = globalThis.OX;
  OX.bridge.onPaused(paused => {
    OX.state.pauseRevision++;
    OX.state.paused = paused;
    if (OX.started) OX.runner.tick();
  });
  OX.bridge.onEngineResumed?.(() => {
    if (OX.started && !OX.state.paused && OX.pageKind() === 'analyse' && !OX.liveGameOnPage()) {
      OX.lichess.restartCeval();
    }
  });
  try {
    OX.settings = { ...OX.defaultSettings, ...(await OX.bridge.loadSettings()) };
  } catch { /* defaults */ }
  const revision = OX.state.pauseRevision;
  try {
    const status = await OX.bridge.status();
    if (status?.reloading) return;
    if (revision === OX.state.pauseRevision) OX.state.paused = status?.paused !== false;
    if (status?.autostart) OX.state.autostart = status.autostart;
  } catch {
    // Not answered: a game may be on in another tab, so stay paused until the
    // background script answers this page's own report (core.js reportPlaying).
    if (revision === OX.state.pauseRevision) OX.state.paused = true;
  }
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
  OX.started = true;
  OX.runner.start();
})();
