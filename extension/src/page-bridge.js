// Runs in Lichess's own page world (manifest: "world": "MAIN"), the only place
// that can reach Lichess's analysis controller (window.site.analysis, set in
// lila ui/analyse/src/analyse.ts). The extension's other scripts live in an
// isolated world: they ask for an action with an "ox-lichess" event and read
// whether it worked from <html data-ox-result> right after (events are
// handled synchronously; "position" also leaves its answer in
// <html data-ox-value>). Only these actions are allowed.
(() => {
  const ALLOWED = new Set(['playUci', 'playUciList', 'jumpToMain', 'userJump', 'practice', 'flip', 'restartCeval', 'position']);
  const paused = () => document.documentElement.hasAttribute('data-ox-paused');
  function handle(event) {
    let ok = false;
    try {
      const { name, args } = JSON.parse(event.detail);
      const ctrl = window.site && window.site.analysis;
      if (ctrl && ALLOWED.has(name) && (!paused() || name === 'position')) {
        if (name === 'practice') {
          if (!ctrl.practice) ctrl.togglePractice(true);
          if (ctrl.practice && ctrl.activeControlBarTool?.()) {
            ctrl.explorer.enabled(false);
            ctrl.actionMenu(false);
          }
          if (ctrl.practice?.running?.() === false) ctrl.practice.resume();
          ok = !!ctrl.practice;
          ctrl.redraw?.();
        } else if (name === 'position') {
          // The position on the board and the one the board started from, as
          // Lichess itself holds them (lila analyse/src/ctrl.ts: node, tree).
          // A study has no FEN box and does not list a chapter's starting
          // position among its tags, so this is the only place that has it.
          const fen = ctrl.node && ctrl.node.fen;
          const start = ctrl.tree && ctrl.tree.root && ctrl.tree.root.fen;
          if (typeof fen === 'string' && typeof start === 'string') {
            document.documentElement.setAttribute('data-ox-value', JSON.stringify({ fen, start }));
            ok = true;
          }
        } else if (name === 'restartCeval') {
          ok = true;
          restartCeval(ctrl);
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
  // After a live game (your Stockfish answered with nothing) or after the app
  // came back: search the position on the board again, as Lichess does on
  // every move (lila analyse/src/ctrl.ts startCevalIfEnabled; it does nothing
  // while the engine is off).
  //
  // Not in every tab at once, though: Lichess runs its engine in ONE tab at a
  // time (lila ceval/ctrl.ts: a tab that starts a search switches the engine
  // off in every other tab). Asked of every open analysis tab, a tab in the
  // background took the engine and the one in front was left with its engine
  // switched off. So the tab you are in searches again (Lichess itself skips
  // a position whose search is complete); another tab does so only when its
  // position has no answer at all, and a hidden one waits until you look at it.
  let restartWaiting = false;
  function restartCeval(ctrl) {
    const node = ctrl.node;
    if (!node) return;
    // A finished position (mate, stalemate) really has no lines.
    const ended = typeof node.outcome === 'function' && node.outcome();
    // Lichess kept the empty answer ("bestmove (none)", no lines) on the
    // position: drop it, so nothing takes it for a result.
    if (node.ceval && !(node.ceval.pvs && node.ceval.pvs.length) && !ended) delete node.ceval;
    // 4 = failed (lila ceval/types.ts CevalState): "Error loading engine".
    const failed = !!ctrl.ceval && ctrl.ceval.state === 4;
    const unanswered = !ended && (!node.ceval || failed);
    restartWaiting = document.hidden && unanswered;
    if (ended || document.hidden || !(unanswered || document.hasFocus())) return;
    // Practice took the empty answer as the computer's turn and won't move
    // again on this position (lila practice/practiceCtrl.ts `played`): start
    // its turn again, as stepping to a position does.
    if (ctrl.practice && typeof ctrl.practice.onJump === 'function') ctrl.practice.onJump();
    if (typeof ctrl.startCevalIfEnabled === 'function') ctrl.startCevalIfEnabled();
  }
  function restartWhenSeen() {
    if (document.hidden || !restartWaiting || paused()) return;
    try {
      const ctrl = window.site && window.site.analysis;
      if (ctrl) restartCeval(ctrl);
    } catch (error) {
      console.warn('[openings]', error);
    }
  }
  if (window.__oxRestartWhenSeen) document.removeEventListener('visibilitychange', window.__oxRestartWhenSeen);
  window.__oxRestartWhenSeen = restartWhenSeen;
  document.addEventListener('visibilitychange', restartWhenSeen);

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
    if (paused()) return;
    try {
      const ctrl = window.site && window.site.analysis;
      const practice = ctrl && ctrl.practice;
      if (!practice || !practice.running() || practice.isMyTurn()) return;
      // A result with lines only: the empty answer given during a live game
      // has none, and Practice would try to play its first line's move.
      const result = ctrl.node.ceval;
      if (!result || !result.bestmove || !(result.pvs && result.pvs.length) || ctrl.ceval.isComputing) return;
      if (nudgedPath !== ctrl.path) { nudgedPath = ctrl.path; nudges = 0; }
      if (nudges++ < 5) practice.onCeval();
    } catch { /* Lichess changed: Practice is simply left as it is */ }
  }
  clearInterval(window.__oxPracticeNudge);
  window.__oxPracticeNudge = setInterval(nudgePractice, 400);
})();
