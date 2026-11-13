// Runs in Lichess's own page world (manifest: "world": "MAIN"), the only place
// that can reach Lichess's analysis controller (window.site.analysis, set in
// lila ui/analyse/src/analyse.ts). The extension's other scripts live in an
// isolated world: they ask for an action with an "ox-lichess" event and read
// whether it worked from <html data-ox-result> right after (events are
// handled synchronously). Only these actions are allowed.
(() => {
  const ALLOWED = new Set(['playUci', 'playUciList', 'jumpToMain', 'userJump', 'practice', 'flip']);
  function handle(event) {
    let ok = false;
    try {
      const { name, args } = JSON.parse(event.detail);
      const ctrl = window.site && window.site.analysis;
      if (ctrl && ALLOWED.has(name)) {
        if (name === 'practice') {
          if (!ctrl.practice) ctrl.togglePractice(true);
          ok = true;
        } else if (typeof ctrl[name] === 'function') {
          ctrl[name](...(args || []));
          ok = true;
        }
      }
    } catch (error) {
      console.warn('[openings]', error);
    }
    document.documentElement.setAttribute('data-ox-result', ok ? '1' : '0');
  }
  // Put in again after an extension update: replace the older copy's listener.
  if (window.__oxLichessBridge) document.removeEventListener('ox-lichess', window.__oxLichessBridge);
  window.__oxLichessBridge = handle;
  document.addEventListener('ox-lichess', handle);

  // Practice (Mastery mode) could wait forever on "Computer thinking…": there
  // Lichess moves for the computer only once the engine is idle (lila
  // practiceCtrl.ts `playable`), but with an external engine the last result
  // arrives while it still counts as computing, and nothing asks again after
  // it stops. So: when Practice is waiting on the computer, the search has a
  // final answer and the engine is idle, ask Lichess to look again (its own
  // onCeval, exactly what a new engine result triggers).
  let nudgedPath = null;
  let nudges = 0;
  function nudgePractice() {
    try {
      const ctrl = window.site && window.site.analysis;
      const practice = ctrl && ctrl.practice;
      if (!practice || !practice.running() || practice.isMyTurn()) return;
      if (!ctrl.node.ceval || !ctrl.node.ceval.bestmove || ctrl.ceval.isComputing) return;
      if (nudgedPath !== ctrl.path) { nudgedPath = ctrl.path; nudges = 0; }
      if (nudges++ < 5) practice.onCeval();
    } catch { /* Lichess changed: Practice is simply left as it is */ }
  }
  clearInterval(window.__oxPracticeNudge);
  window.__oxPracticeNudge = setInterval(nudgePractice, 400);
})();
