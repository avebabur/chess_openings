// Starts the extension on a lichess.org page.
(async () => {
  const OX = globalThis.OX;
  // The app is back after being down: Lichess's engine bar was left with an
  // error, so have it search again.
  OX.bridge.onEngineResumed?.(() => {
    if (OX.started && OX.pageKind() === 'analyse' && !OX.gameInProgressHere()) OX.lichess.restartCeval();
  });
  try {
    OX.settings = { ...OX.defaultSettings, ...(await OX.bridge.loadSettings()) };
  } catch { /* defaults */ }
  try {
    const status = await OX.bridge.status();
    if (status?.reloading) return; // this copy is about to be replaced
    if (status?.autostart) OX.state.autostart = status.autostart;
  } catch { /* the background script will answer the boxes' own requests */ }
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
