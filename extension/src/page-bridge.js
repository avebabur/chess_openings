// Runs in Lichess's own page world (manifest: "world": "MAIN"), the only place
// that can reach Lichess's analysis controller (window.site.analysis, set in
// lila ui/analyse/src/analyse.ts). The extension's other scripts live in an
// isolated world: they ask for an action with an "ox-lichess" event and read
// whether it worked from <html data-ox-result> right after (events are
// handled synchronously; "position" and "annotationData" also leave their
// answer in <html data-ox-value>; "publishAnalysis" answers later with an
// "ox-lichess-reply" event). Only these actions are allowed.
(() => {
  const ALLOWED = new Set(['playUci', 'playUciList', 'jumpToMain', 'userJump', 'flip', 'restartCeval', 'position',
    'annotationData', 'publishAnalysis']);
  const isNum = value => typeof value === 'number' && Number.isFinite(value);

  // A study chapter's main line with the result Lichess holds for each
  // position (your engine's at the depth it reached, or the cloud's), for
  // src/annotate-core.js. null outside a study.
  function annotationData(ctrl) {
    const study = ctrl.study;
    if (!study || !Array.isArray(ctrl.mainline)) return null;
    return {
      studyId: study.data && study.data.id,
      chapterId: (study.vm && study.vm.chapterId) || (study.data && study.data.chapter && study.data.chapter.id),
      user: document.body.dataset.user || '',
      canContribute: !!(study.members && study.members.canContribute && study.members.canContribute()),
      nodes: ctrl.mainline.map(node => {
        const e = node.ceval;
        const pv = e && e.pvs && e.pvs[0];
        return {
          ply: node.ply, fen: node.fen, uci: node.uci || null, san: node.san || null,
          ceval: e && pv && Array.isArray(pv.moves) && pv.moves.length ? {
            cp: isNum(e.cp) ? e.cp : null, mate: isNum(e.mate) ? e.mate : null, depth: e.depth || 0,
            nodes: e.nodes || 0, engineId: e.engineId || null, cloud: !!e.cloud, pv: pv.moves.slice(0, 12),
          } : null,
          eval: node.eval && (isNum(node.eval.cp) || isNum(node.eval.mate))
            ? { cp: isNum(node.eval.cp) ? node.eval.cp : null, mate: isNum(node.eval.mate) ? node.eval.mate : null,
              best: node.eval.best || null }
            : null,
        };
      }),
    };
  }

  // Lichess's own Publish (lila: POST /analysis/publish, Study.postAnalysisXhr),
  // made from this page so it carries your Lichess login. The answer comes
  // back as an "ox-lichess-reply" event: { status, message }.
  function publishAnalysis(analysis) {
    const reply = detail => document.dispatchEvent(new CustomEvent('ox-lichess-reply',
      { detail: JSON.stringify({ name: 'publishAnalysis', ...detail }) }));
    fetch('/analysis/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(analysis),
    }).then(async response => reply({ status: response.status,
      message: response.ok ? '' : (await response.text()).slice(0, 300) }))
      .catch(error => reply({ status: 0, message: String(error) }));
  }
  function handle(event) {
    let ok = false;
    try {
      const { name, args } = JSON.parse(event.detail);
      const ctrl = window.site && window.site.analysis;
      if (ctrl && ALLOWED.has(name)) {
        if (name === 'position') {
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
        } else if (name === 'annotationData') {
          const data = annotationData(ctrl);
          if (data) {
            document.documentElement.setAttribute('data-ox-value', JSON.stringify(data));
            ok = true;
          }
        } else if (name === 'publishAnalysis') {
          const analysis = args && args[0];
          if (ctrl.study && /^\/study\//.test(location.pathname) && analysis && typeof analysis === 'object') {
            publishAnalysis(analysis);
            ok = true;
          }
        } else if (name === 'restartCeval') {
          ok = true;
          restartCeval(ctrl);
        } else if (typeof ctrl[name] === 'function') {
          ctrl[name](...(args || []));
          // The controller moves the board, but its callers redraw the move list.
          if (name === 'jumpToMain') ctrl.redraw?.();
          ok = true;
        }
      }
    } catch (error) {
      console.warn('[openings]', error);
    }
    document.documentElement.setAttribute('data-ox-result', ok ? '1' : '0');
  }
  // After the app came back (Lichess's engine bar was left with an error):
  // search the position on the board again, as Lichess does on
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
    // Practice took an empty answer as the computer's turn and won't move
    // again on this position (lila practice/practiceCtrl.ts `played`): start
    // its turn again, as stepping to a position does.
    if (ctrl.practice && typeof ctrl.practice.onJump === 'function') ctrl.practice.onJump();
    if (typeof ctrl.startCevalIfEnabled === 'function') ctrl.startCevalIfEnabled();
  }
  function restartWhenSeen() {
    if (document.hidden || !restartWaiting) return;
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

  // Only when the request goes to Lichess's engine service (the app on this
  // computer could not answer it, see localAnalyse below):
  // stepping through a game at a normal clicking pace made Lichess pop up
  // "Your Stockfish error: TypeError: Failed to fetch" and switch the engine
  // off. Lichess's engine service (engine.lichess.ovh) allows each address a
  // limited number of requests (measured Nov 2026: about 60 at once, then two
  // or three a second), and every position costs three of them: the page's
  // request for analysis and the app's two (taking the job, answering it).
  // Past the limit the service refuses with a bare 503 that the page may not
  // even read, so Lichess sees a network failure and gives up.
  //
  // So the page's analysis requests are paced to stay under that limit: the
  // first dozen positions in a row are asked at once, as before; after that
  // one every second and a half. A request Lichess cancels while it waits
  // (you moved on) is never sent, so quick stepping costs nothing and the
  // position you stop on is analysed. If the service refuses anyway (another
  // tab or device is using it too), the request is tried again a few times
  // before Lichess hears of it. Nothing else Lichess fetches is touched.
  const ANALYSE_PATH = /^\/api\/external-engine\/([^/]+)\/analyse$/;
  const BROKER_ORIGIN = 'https://engine.lichess.ovh';
  const POSITION_COST = 3;
  const BUDGET_MAX = 36;      // requests kept in hand: 12 positions at once
  const BUDGET_PER_SECOND = 2;
  const BUDGET_KEY = 'ox.engineBudget';
  const REFUSED_WAITS = [2000, 4000, 6000];
  let budgetHere = { left: BUDGET_MAX, at: Date.now() };
  // Shared by every Lichess tab (they share the address the limit is on).
  function readBudget() {
    let saved = budgetHere;
    try {
      const stored = JSON.parse(localStorage.getItem(BUDGET_KEY) || 'null');
      if (stored && Number.isFinite(stored.left) && Number.isFinite(stored.at) && stored.at <= Date.now()) saved = stored;
    } catch { /* storage blocked: this tab keeps count by itself */ }
    const now = Date.now();
    return { left: Math.min(BUDGET_MAX, Math.max(0, saved.left) + ((now - saved.at) / 1000) * BUDGET_PER_SECOND), at: now };
  }
  function writeBudget(budget) {
    budgetHere = budget;
    try { localStorage.setItem(BUDGET_KEY, JSON.stringify(budget)); } catch { /* as above */ }
  }
  const aborted = signal => signal.reason || new DOMException('The request was cancelled.', 'AbortError');
  // Resolves after `ms`; rejects as fetch itself would when `signal` aborts.
  function pause(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(aborted(signal));
      const stop = () => { clearTimeout(timer); reject(aborted(signal)); };
      const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', stop); resolve(); }, ms);
      if (signal) signal.addEventListener('abort', stop, { once: true });
    });
  }
  // Opening positions mostly have a cloud evaluation, and Lichess sends them
  // to your Stockfish anyway: it only stops the search after the first line
  // comes back, when it sees that the cloud searched far more than yours can
  // in its time (lila lib/src/ceval/ctrl.ts letCloudWin). Each of those still
  // cost three requests, so stepping through an opening used up the allowance
  // and the middlegame after it showed "Loading engine" at every other move.
  // So where Lichess looks for a cloud evaluation (canEvalGet in lila
  // analyse/src/ctrl.ts: before move 15, or anywhere in a study), the request
  // waits a moment for it, and is not sent when Lichess's own rule says the
  // cloud wins. Lichess then hears what it hears when it stops a search itself
  // (AbortError) and keeps showing the cloud's lines. Go deeper, Practice and
  // anything this can't read are always sent.
  const CLOUD_WAIT_MS = 300;  // the cloud's answer arrived ~50 ms after a move (Nov 2026)
  const CLOUD_POLL_MS = 50;
  function cloudLooked(ctrl) {
    try { return !!ctrl && typeof ctrl.canEvalGet === 'function' && ctrl.canEvalGet() === true; } catch { return false; }
  }
  function cloudWins(ctrl) {
    try {
      const ceval = ctrl.ceval;
      if (ctrl.practice || ceval.isDeeper() || ceval.isInfinite || ceval.opts?.custom) return false;
      const by = ceval.search.by;
      const movetime = 'movetime' in by && by.movetime;
      return ceval.letCloudWin({ millis: 0, nodes: 0 }, movetime, ceval.lastStarted) === true;
    } catch { return false; }
  }
  async function cloudCovers(signal) {
    const ctrl = window.site && window.site.analysis;
    if (!cloudLooked(ctrl)) return false;
    for (let waited = 0; ; waited += CLOUD_POLL_MS) {
      if (cloudWins(ctrl)) return true;
      if (waited >= CLOUD_WAIT_MS) return false;
      await pause(CLOUD_POLL_MS, signal);
    }
  }
  async function pacedAnalyse(send, signal) {
    if (await cloudCovers(signal)) throw new DOMException('The cloud evaluation is deeper.', 'AbortError');
    for (let attempt = 0; ; attempt++) {
      let budget = readBudget();
      while (budget.left < POSITION_COST) {
        await pause(Math.ceil(((POSITION_COST - budget.left) / BUDGET_PER_SECOND) * 1000) + 20, signal);
        budget = readBudget();
      }
      if (signal?.aborted) throw aborted(signal);
      writeBudget({ left: budget.left - POSITION_COST, at: budget.at });
      try {
        const response = await send();
        if (response.status !== 429 && response.status !== 503) return response;
        writeBudget({ left: 0, at: Date.now() });
        if (attempt >= REFUSED_WAITS.length || signal?.aborted) return response;
        response.body?.cancel().catch(() => {});
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        writeBudget({ left: 0, at: Date.now() });
        if (attempt >= REFUSED_WAITS.length) throw error;
      }
      await pause(REFUSED_WAITS[attempt], signal);
    }
  }
  // Your Stockfish answered on this computer, with no trip through Lichess's
  // engine service at all: the request goes to the extension (engine-relay.js,
  // then the background script, which may reach the app; Lichess's page may
  // not) and the app streams back exactly what the service would have sent
  // (backend/lichess_engine_provider.py local_analysis). No allowance is used,
  // so stepping through a game never runs into the service's limit, and no
  // cloud wait is needed: Lichess itself stops your Stockfish when the cloud
  // wins. Anything else (the extension not there, the app not running, an
  // engine that is not the app's) goes to the service as before.
  const LOCAL_ASK = 'ox-engine';
  const LOCAL_REPLY = 'ox-engine-reply';
  const LOCAL_ACK = 'data-ox-engine-ack';
  const localJobs = new Map();
  let localCount = 0;
  function localReply(event) {
    let message = null;
    try { message = JSON.parse(event.detail); } catch { return; }
    if (message && typeof message.id === 'string') localJobs.get(message.id)?.(message);
  }
  if (window.__oxLocalReply) document.removeEventListener(LOCAL_REPLY, window.__oxLocalReply);
  window.__oxLocalReply = localReply;
  document.addEventListener(LOCAL_REPLY, localReply);
  const tellRelay = message => document.dispatchEvent(new CustomEvent(LOCAL_ASK, { detail: JSON.stringify(message) }));
  // A Response streaming the app's lines, or null: ask Lichess's service instead.
  function localAnalyse(engineId, body, signal) {
    if (signal?.aborted) return Promise.reject(aborted(signal));
    let work = null;
    try { work = JSON.parse(body).work; } catch { return Promise.resolve(null); }
    if (!work || typeof work !== 'object') return Promise.resolve(null);
    const id = `${Date.now()}.${++localCount}.${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      let lines = null; // the body's controller, once Lichess has the Response
      const encoder = new TextEncoder();
      const finish = () => {
        localJobs.delete(id);
        signal?.removeEventListener('abort', cancel);
      };
      function cancel() {
        if (!localJobs.has(id)) return;
        finish();
        tellRelay({ op: 'abort', id });
        if (lines) { try { lines.error(aborted(signal)); } catch { /* already closed */ } }
        else reject(aborted(signal));
      }
      // Listening before asking: the relay may answer while it is asked.
      localJobs.set(id, message => {
        if (!lines) {
          if (message.kind !== 'start') { finish(); resolve(null); return; } // not answered here
          const stream = new ReadableStream({
            start(controller) { lines = controller; },
            cancel() { if (localJobs.has(id)) { finish(); tellRelay({ op: 'abort', id }); } },
          });
          resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }));
          return;
        }
        try {
          if (message.kind === 'chunk' && typeof message.text === 'string') lines.enqueue(encoder.encode(message.text));
          else if (message.kind === 'end') { finish(); lines.close(); }
          else if (message.kind !== 'chunk') { finish(); lines.error(new TypeError('Failed to fetch')); }
        } catch { finish(); }
      });
      signal?.addEventListener('abort', cancel, { once: true });
      let taken = false;
      try {
        const root = document.documentElement;
        root.removeAttribute(LOCAL_ACK);
        tellRelay({ op: 'analyse', id, engineId, work });
        // The relay takes the request synchronously, as events are handled.
        taken = root.getAttribute(LOCAL_ACK) === id;
        root.removeAttribute(LOCAL_ACK);
      } catch { taken = false; }
      if (!taken && localJobs.has(id)) { finish(); resolve(null); }
    });
  }

  // Put in again after an extension update: wrap Lichess's fetch, not the
  // older copy's wrapper.
  const pageFetch = window.__oxPageFetch || window.fetch;
  window.__oxPageFetch = pageFetch;
  window.fetch = function (input, init) {
    let paced = false;
    let address = null;
    try {
      address = typeof input === 'string' || input instanceof URL ? new URL(input, location.href) : null;
      const body = init && init.body;
      paced = address?.origin === BROKER_ORIGIN && ANALYSE_PATH.test(address.pathname)
        && String((init && init.method) || '').toLowerCase() === 'post'
        && (body == null || typeof body === 'string');
    } catch { paced = false; }
    if (!paced) return pageFetch.apply(this, arguments);
    const engineId = ANALYSE_PATH.exec(address.pathname)[1];
    return localAnalyse(engineId, init.body, init.signal)
      .then(response => response || pacedAnalyse(() => pageFetch.call(window, input, init), init.signal));
  };

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
      // A result with lines only: an empty answer (a search stopped before it
      // began) has none, and Practice would try to play its first line's move.
      const result = ctrl.node.ceval;
      if (!result || !result.bestmove || !(result.pvs && result.pvs.length) || ctrl.ceval.isComputing) return;
      if (nudgedPath !== ctrl.path) { nudgedPath = ctrl.path; nudges = 0; }
      if (nudges++ < 5) practice.onCeval();
    } catch { /* Lichess changed: Practice is simply left as it is */ }
  }
  clearInterval(window.__oxPracticeNudge);
  window.__oxPracticeNudge = setInterval(nudgePractice, 400);
})();
