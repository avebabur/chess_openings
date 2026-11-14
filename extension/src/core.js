// The runner: decides what kind of Lichess page this is, places each feature
// at its anchor, keeps it there when Lichess re-draws, and reports any feature
// that cannot find its place.
//
// Safety rules every feature relies on:
//  * A game in progress (in any tab) pauses everything. Fail-closed: a game
//    page counts as live until its result box shows.
//  * Features only ADD elements next to Lichess's and never block its
//    events. The few changes to Lichess's own layout (hiding the WikiBook and
//    the explorer's Player tab, the board colours, where the explorer and the
//    chat sit) are all in src/page.css and features/explorerleft.js.
//  * A missing anchor means the feature is simply left out, never an error on
//    the page. Any exception inside a feature removes just that feature.
(() => {
  const OX = (globalThis.OX = globalThis.OX || {});
  const A = OX.anchors;

  // ---------- small helpers ----------
  OX.$ = (selector, root = document) => {
    try { return root.querySelector(selector); } catch { return null; }
  };
  OX.el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child != null) node.append(child);
    return node;
  };

  const listeners = {};
  // Returns a function that stops listening.
  OX.on = (name, callback) => {
    (listeners[name] = listeners[name] || []).push(callback);
    return () => { listeners[name] = listeners[name].filter(other => other !== callback); };
  };
  OX.emit = (name, data) => {
    for (const callback of listeners[name] || []) {
      try { callback(data); } catch (error) { console.warn('[openings]', error); }
    }
  };

  OX.state = { paused: false, position: null, offline: false, autostart: null };
  // mineOpen: the explorer's My games tab is the chosen one.
  OX.defaultSettings = { mineOpen: false };

  // What to say while the local service is down. With the auto-start helper installed
  // the background script is already starting it.
  OX.offlineText = () => (OX.state.autostart === 'unavailable'
    ? "The local extension service isn't running. Start it with ./start.sh."
    : 'Starting the local extension service…');
  OX.settings = { ...OX.defaultSettings };
  OX.setSetting = (key, value) => {
    OX.settings[key] = value;
    OX.bridge.saveSettings(OX.settings);
    OX.emit('settings', key);
  };

  // Position key for matching FENs: placement, side to move, castling. The
  // en-passant field is left out (Lichess and the app may disagree on it).
  OX.positionKey = fen => fen.split(' ').slice(0, 3).join(' ');

  // "+0.20", "-1.35", "#3", "#-2" from a White-POV eval (mates are ±(1000+n)).
  OX.formatEval = value => {
    if (value == null || Number.isNaN(value)) return '–';
    if (Math.abs(value) >= 1000) {
      const n = Math.round(Math.abs(value) - 1000);
      return value > 0 ? `#${n}` : `#-${n}`;
    }
    return (value > 0 ? '+' : '') + value.toFixed(2);
  };

  // Opening names imported from chess.com before the importer was fixed can
  // end in a dangling "with" ("Modern Defense with" for "…with 1.d4").
  OX.openingName = name => (name || '').replace(/\s+with$/i, '');

  // SAN moves with numbers, starting from the position in fen.
  OX.numberMoves = (fen, sans) => {
    const parts = fen.split(' ');
    let white = parts[1] === 'w';
    let number = parseInt(parts[5], 10) || 1;
    return sans.map((san, i) => {
      let text = san;
      if (white) text = `${number}. ${san}`;
      else if (i === 0) text = `${number}… ${san}`;
      if (!white) number += 1;
      white = !white;
      return text;
    }).join(' ');
  };

  // ---------- page understanding ----------
  OX.pageKind = () => {
    if (OX.$(A.roundPage.selector)) return 'round';
    if (OX.$(A.analysePage.selector)) return 'analyse';
    return 'other';
  };

  OX.liveGameOnPage = () => OX.pageKind() === 'round' && !OX.$(A.roundFinished.selector);

  OX.isStudy = () => /^\/study\/[A-Za-z0-9]{8}/.test(location.pathname);

  // The id of the Lichess game this page is about (/abcd1234, /abcd1234/black,
  // /game/abcd1234, or the 12-character address of a game you played), or
  // null. "/analysis" has the same shape as a game id and is not one.
  OX.lichessGameId = () => {
    const id = /^\/(?:game\/)?([A-Za-z0-9]{8})(?:[A-Za-z0-9]{4})?(?:\/(?:white|black))?\/?$/.exec(location.pathname)?.[1];
    return id && id !== 'analysis' ? id : null;
  };

  // Pages where the analysis features are expected, so a missing anchor there
  // means Lichess changed: the analysis board, finished games and studies.
  // Other analysis-style pages (broadcasts…) get the features when the
  // anchors happen to exist, but are never reported as broken.
  OX.analysisExpected = () =>
    OX.isStudy() || /^\/analysis(\/|$)/.test(location.pathname) || !!OX.lichessGameId();

  OX.standardVariant = () => {
    const main = OX.$(A.analysePage.selector);
    if (!main) return false;
    const variants = [...main.classList].filter(c => c.startsWith('variant-'));
    return variants.length === 0 || variants.some(c => OX.standardVariantClasses.includes(c));
  };

  OX.interactiveLesson = () =>
    !!OX.$(A.analysePage.selector)?.classList.contains(OX.gamebookClass);

  // Where this page's position comes from: the FEN box when Lichess has one,
  // else the move list (studies have no FEN box).
  OX.positionAnchor = () => {
    if (OX.$(A.fenInput.selector)) return 'fenInput';
    if (OX.isStudy() || OX.$(A.moveList.selector)) return 'moveList';
    return 'fenInput';
  };

  OX.readPosition = () => {
    if (OX.positionAnchor() === 'moveList') return positionFromMoves();
    const fen = OX.$(A.fenInput.selector)?.value?.trim();
    if (!fen || fen.split(' ').length < 4) return null;
    return { fen, key: OX.positionKey(fen) };
  };

  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  let movesCache = { id: null, position: null };

  function chapterStartFen() {
    const tags = OX.$(A.studyTags.selector);
    if (!tags) return START_FEN;
    for (const row of tags.querySelectorAll('tr')) {
      if (row.querySelector('th')?.textContent.trim().toUpperCase() !== 'FEN') continue;
      const cell = row.querySelector('td');
      const value = (cell?.querySelector('input')?.value || cell?.textContent || '').trim();
      if (value.split(' ').length >= 4) return value;
    }
    return START_FEN;
  }

  // The moves (SAN) from the start to the highlighted move, as Lichess's move
  // list shows them (null in a study chapter that starts from another
  // position). Not checked against the board: see currentLine.
  OX.movesOnBoard = () => {
    const list = OX.$(A.moveList.selector);
    if (!list || chapterStartFen() !== START_FEN) return null;
    const path = OX.$(A.activeMove.selector, list)?.getAttribute('p') || '';
    const sans = [];
    for (let end = 2; end <= path.length; end += 2) {
      const san = list.querySelector(`move[p="${CSS.escape(path.slice(0, end))}"] san`)?.textContent.trim();
      if (!san) return null;
      sans.push(san);
    }
    return sans;
  };

  // The moves from the normal starting position to the position on the board,
  // or null. The analysis board can start from a position set up on it (or a
  // game from a position): its moves then lead somewhere else from the normal
  // start, and saving them as a line would save the wrong line.
  OX.currentLine = () => {
    const sans = OX.movesOnBoard();
    const here = OX.readPosition();
    if (!sans || !here) return null;
    try {
      const chess = new globalThis.OXChess(START_FEN);
      for (const san of sans) chess.move(san);
      return OX.positionKey(chess.fen()) === here.key ? sans : null;
    } catch { return null; }
  };

  // Replays the moves from the chapter's start to the highlighted move.
  function positionFromMoves() {
    const list = OX.$(A.moveList.selector);
    if (!list) return null;
    const path = OX.$(A.activeMove.selector, list)?.getAttribute('p') || '';
    const start = chapterStartFen();
    const id = `${start}|${path}`;
    if (movesCache.id === id) return movesCache.position;
    let position = null;
    try {
      const chess = new globalThis.OXChess(start);
      let ok = true;
      for (let end = 2; end <= path.length && ok; end += 2) {
        const move = list.querySelector(`move[p="${CSS.escape(path.slice(0, end))}"]`);
        const san = move?.querySelector('san')?.textContent.trim();
        ok = !!san && !!chess.move(san);
      }
      if (ok) position = { fen: chess.fen(), key: OX.positionKey(chess.fen()) };
    } catch { position = null; }
    movesCache = { id, position };
    return position;
  }

  // ---------- features ----------
  // A feature: { id, name, pages, anchors, place?, needsPosition, create() }
  //   place: { anchor, where: 'after' | 'prepend' | 'append', order, shadow }
  //   create(host, root) -> { update(position), destroy() }
  const features = [];
  OX.defineFeature = feature => features.push({ order: 0, needsPosition: false, ...feature });

  function makeHost(feature) {
    const shadow = feature.place.shadow !== false;
    const host = document.createElement(feature.place.tag || 'div');
    host.dataset.oxHost = feature.id;
    host.className = `ox-host ox-host--${feature.id}`;
    if (!shadow) return { host, root: host };
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = OX.css;
    const root = document.createElement('div');
    root.className = 'ox';
    shadowRoot.append(style, root);
    // Typing in our boxes must not trigger Lichess's keyboard shortcuts.
    for (const type of ['keydown', 'keypress', 'keyup']) {
      shadowRoot.addEventListener(type, event => {
        if (event.target?.matches?.('input, select')) event.stopPropagation();
      });
    }
    return { host, root };
  }

  const GRACE_MS = 8000; // Lichess draws its page in steps; wait before calling an anchor missing.
  const HIDDEN_MS = 3000;
  const MISSING_MS = 1500;
  const run = new Map(); // feature id -> { host, root, instance, status, detail, ... }
  let pageStart = Date.now();
  let lastKind = null;
  let lastReport = '';
  let lastPlaying = null;
  let playingSentAt = 0;
  let lastPositionKey = null;
  const PLAYING_AGAIN_MS = 5000;

  // Tells the background script whether this page shows a game in progress.
  // Sent on every change, again every few seconds while a game is live (so a
  // lock the background lost comes back by itself), and again whenever the
  // answer didn't arrive.
  function reportPlaying(playing) {
    const due = playing !== lastPlaying || (playing && Date.now() - playingSentAt > PLAYING_AGAIN_MS);
    if (!due) return;
    lastPlaying = playing;
    playingSentAt = Date.now();
    OX.bridge.setPlaying(playing).then(res => {
      if (res && typeof res.paused === 'boolean') OX.state.paused = res.paused;
      else setTimeout(() => { lastPlaying = null; }, 1000); // not heard: say it again shortly
    });
  }
  // A page brought back by the browser's Back button keeps its scripts but the
  // background script has forgotten it: report again.
  addEventListener('pageshow', event => { if (event.persisted) lastPlaying = null; });

  function teardown(id) {
    const entry = run.get(id);
    if (!entry) return;
    try { entry.instance?.destroy?.(); } catch (error) { console.warn('[openings]', error); }
    entry.host?.remove();
    run.set(id, {
      status: entry.status, failed: entry.failed, detail: entry.detail,
      everOk: entry.everOk, missingSince: entry.missingSince,
    });
  }

  function setStatus(id, status, detail = '', missing = []) {
    const entry = run.get(id) || {};
    entry.status = status;
    entry.detail = detail;
    entry.missing = missing;
    run.set(id, entry);
  }

  function fail(feature, error) {
    console.warn(`[openings] ${feature.name} stopped:`, error);
    teardown(feature.id);
    const entry = run.get(feature.id) || {};
    entry.failed = String(error?.message || error).slice(0, 200);
    run.set(feature.id, entry);
    setStatus(feature.id, 'error', entry.failed);
  }

  function placeGroup(group) {
    // Features sharing an anchor+where are kept together in `order`.
    const first = group[0];
    const anchorEl = OX.$(A[first.place.anchor].selector);
    if (!anchorEl) return;
    let previous = null;
    for (const feature of group) {
      const entry = run.get(feature.id);
      if (!entry?.host) continue;
      const host = entry.host;
      if (previous) {
        if (previous.nextSibling !== host) previous.after(host);
      } else if (first.place.where === 'after') {
        if (anchorEl.nextSibling !== host) anchorEl.after(host);
      } else if (first.place.where === 'prepend') {
        if (anchorEl.firstChild !== host) anchorEl.prepend(host);
      } else if (host.parentNode !== anchorEl) {
        anchorEl.append(host);
      }
      previous = host;
    }
  }

  function checkVisible(feature, entry) {
    const anchorEl = OX.$(A[feature.place.anchor].selector);
    const anchorShown = anchorEl && anchorEl.getClientRects().length > 0;
    const shown = entry.host.getClientRects().length > 0 &&
      (entry.host.getBoundingClientRect().height > 0 || feature.place.zeroHeightOk);
    // A panel tab that isn't the open one (features/sidetabs.js) is fine.
    const closedTab = feature.place.tab && entry.host.style.display === 'none';
    if (!anchorShown || shown || closedTab) { entry.hiddenSince = null; return true; }
    entry.hiddenSince = entry.hiddenSince || Date.now();
    return Date.now() - entry.hiddenSince < HIDDEN_MS;
  }

  let timer = null;
  // This copy was cut off by an extension update: remove everything it added
  // and stop. The background script has already put the new copy in.
  function retire() {
    if (OX.retired) return;
    OX.retired = true;
    clearInterval(timer);
    for (const feature of features) teardown(feature.id);
  }

  function tick() {
    if (OX.retired) return;
    if (OX.bridge.alive && !OX.bridge.alive()) return retire();
    const kind = OX.pageKind();
    if (kind !== lastKind) { lastKind = kind; pageStart = Date.now(); }
    const playing = OX.liveGameOnPage();
    reportPlaying(playing);
    const paused = OX.state.paused || playing;
    const inGrace = Date.now() - pageStart < GRACE_MS;
    const position = kind === 'analyse' && !paused && OX.standardVariant() ? OX.readPosition() : null;
    OX.state.position = position;
    const positionChanged = (position?.key || null) !== lastPositionKey;
    lastPositionKey = position?.key || null;

    for (const feature of features) {
      const entry = run.get(feature.id) || {};
      if (!feature.pages.includes(kind)) { teardown(feature.id); setStatus(feature.id, 'n/a'); continue; }
      if (paused && feature.pauses !== false) { teardown(feature.id); setStatus(feature.id, 'paused'); continue; }
      if (entry.failed) continue; // stays out until the page reloads
      if (kind === 'analyse' && !OX.standardVariant()) { teardown(feature.id); setStatus(feature.id, 'n/a', 'variant'); continue; }
      if (kind === 'analyse' && OX.interactiveLesson() && feature.needsPosition) {
        teardown(feature.id); setStatus(feature.id, 'n/a', 'interactive lesson'); continue;
      }

      const missing = [...feature.anchors, ...(feature.needsPosition ? [OX.positionAnchor()] : [])]
        .filter((name, i, all) => all.indexOf(name) === i)
        .filter(name => !OX.$(A[name].selector));
      if (missing.length && feature.optional) {
        // Its place only exists sometimes (the explorer while it is open).
        teardown(feature.id);
        setStatus(feature.id, 'n/a', 'not open');
        continue;
      }
      if (missing.length || (feature.needsPosition && !position)) {
        teardown(feature.id);
        const expected = kind !== 'analyse' || OX.analysisExpected();
        // A feature that was showing and lost its anchor gets a short wait
        // (Lichess may be mid-redraw); one never seen gets the page-load grace.
        const gone = run.get(feature.id) || {};
        run.set(feature.id, gone);
        gone.missingSince = gone.missingSince || Date.now();
        const settling = gone.everOk ? Date.now() - gone.missingSince < MISSING_MS : inGrace;
        const status = !expected ? 'n/a' : settling ? 'waiting' : 'missing';
        setStatus(feature.id, status, missing.length ? '' : `couldn't read the position (${OX.positionAnchor()})`,
          missing.map(name => ({ name, selector: A[name].selector })));
        continue;
      }

      entry.missingSince = null;
      try {
        if (!entry.host) {
          const { host, root } = makeHost(feature);
          entry.host = host;
          entry.root = root;
          run.set(feature.id, entry);
          entry.instance = feature.create(host, root) || {};
          entry.needsUpdate = true;
        }
      } catch (error) { fail(feature, error); continue; }
    }

    // Place every mounted host (re-inserting any Lichess's re-draw removed).
    const groups = new Map();
    for (const feature of features) {
      const entry = run.get(feature.id);
      if (!entry?.host) continue;
      if (feature.place.custom) {
        // The feature positions itself (e.g. before a particular button).
        const anchorEl = OX.$(A[feature.place.anchor].selector);
        try { if (anchorEl) feature.place.custom(anchorEl, entry.host); } catch (error) { fail(feature, error); }
        continue;
      }
      const key = `${feature.place.anchor}|${feature.place.where}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(feature);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.order - b.order);
      try { placeGroup(group); } catch (error) { group.forEach(f => fail(f, error)); }
    }

    for (const feature of features) {
      const entry = run.get(feature.id);
      if (!entry?.host) continue;
      try {
        if (entry.needsUpdate || positionChanged) {
          entry.needsUpdate = false;
          // update() may be async: a rejection takes just this feature out too.
          Promise.resolve(entry.instance.update?.(position)).catch(error => fail(feature, error));
        }
        entry.instance.tick?.(position);
      } catch (error) { fail(feature, error); continue; }
      const visible = checkVisible(feature, entry);
      if (visible) entry.everOk = true;
      setStatus(feature.id, visible ? 'ok' : 'hidden',
        entry.hiddenSince ? 'added, but it has no size on the page' : '');
    }

    recoverWhenBack();
    maybeReport(kind);
  }

  // A box that said "app isn't running" must come back by itself once it is.
  let lastProbe = 0;
  function recoverWhenBack() {
    if (!OX.state.offline || Date.now() - lastProbe < 2500) return;
    lastProbe = Date.now();
    OX.bridge.api('GET', '/health').then(() => {
      OX.state.offline = false;
      for (const entry of run.values()) if (entry.host) entry.needsUpdate = true;
      OX.emit('online');
    }).catch(() => {});
  }

  function maybeReport(kind) {
    const statuses = features.map(f => [f.id, run.get(f.id)?.status || 'n/a']);
    if (statuses.some(([, s]) => s === 'waiting')) return; // never report a moment mid-redraw
    const report = {
      page_kind: kind,
      url: location.origin + location.pathname,
      extension_version: OX.bridge.version,
      features: Object.fromEntries(features.map(f => {
        const entry = run.get(f.id) || {};
        return [f.id, {
          name: f.name,
          status: entry.status || 'n/a',
          detail: entry.detail || '',
          missing_anchors: entry.missing || [],
        }];
      })),
    };
    const signature = JSON.stringify([kind, report.features]);
    if (signature === lastReport) return;
    lastReport = signature;
    OX.bridge.report(report);
  }

  OX.runner = {
    tick,
    retire,
    start() {
      if (OX.retired || timer) return;
      tick();
      timer = setInterval(tick, 300);
    },
    status: () => Object.fromEntries(features.map(f => [f.id, run.get(f.id)?.status || 'n/a'])),
  };
})();
