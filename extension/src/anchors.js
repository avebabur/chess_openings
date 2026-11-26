// Every place the extension touches Lichess's page, in one list.
//
// When Lichess changes its layout and a feature stops showing, the health
// report (extension/health-report.json) names the anchor below that stopped
// matching. Fix the selector HERE; nothing else should need to change.
// See extension/REPAIR.md.
(() => {
  // First script of every injection. After an extension update Chrome puts the
  // new copy into the SAME script world as the old one, so start from a fresh
  // OX: the old copy keeps its own object (and its dead line to the old
  // background script, which makes it remove itself), and nothing of it is
  // mistaken for this copy's state.
  try { globalThis.OX?.runner?.retire?.(); } catch { /* an older copy without retire() */ }
  const OX = (globalThis.OX = {});

  OX.anchors = {
    analysePage: {
      selector: 'main.analyse',
      what: 'The analysis board page (also used for finished games and studies)',
    },
    roundPage: {
      selector: 'main.round',
      what: 'A game in progress, played or watched. Everything pauses on it.',
    },
    roundFinished: {
      selector: 'main.round .result-wrap',
      what: 'The result box on a game page once the game has ended. While it is missing the game counts as live (safe default).',
    },
    fenInput: {
      selector: 'main.analyse .copyables input.copyable, main.analyse .analyse__underboard__fen input',
      what: 'The FEN box under the board: .copyables on the analysis board, .analyse__underboard__fen on finished games (Lichess updates it on every move, even while its panel is hidden). The current position is read from it.',
    },
    moveList: {
      selector: 'main.analyse .analyse__moves',
      what: "The move list. The moves of the line on the board are read from it. Where there is no FEN box (studies) the position itself is asked of Lichess's controller (src/page-bridge.js), and worked out from these moves only if that can't be reached.",
    },
    activeMove: {
      selector: 'move.active',
      what: "Inside the move list: the highlighted move. Its p attribute is Lichess's path, 2 characters per move, so each earlier move on the way has p equal to a prefix of it.",
    },
    studyTags: {
      selector: 'main.analyse .study__tags',
      what: 'The PGN tags of a study chapter. Only a fallback: Lichess does not list a chapter\'s starting position here, its controller has it (src/page-bridge.js).',
    },
    ceval: {
      selector: 'main.analyse .analyse__tools > .ceval',
      what: "Lichess's own engine bar. Your Stockfish and Your repertoire go right under it.",
    },
    side: {
      selector: 'main.analyse aside.analyse__side',
      what: "The left column (where Lichess's WikiBook was, which the extension hides). Your repertoire goes here.",
    },
    explorerBox: {
      selector: 'main.analyse section.explorer-box',
      what: "Lichess's opening explorer (opened with the book button under the board).",
    },
    explorerTitle: {
      selector: 'main.analyse section.explorer-box .explorer-title',
      what: "The explorer's tab row (Masters / Lichess / Player). The My games tab is added before its gear button. Only exists while the explorer is open and has data, so its absence is normal.",
    },
  };

  // Lichess pages whose address has the shape of a game's (8 letters and
  // digits) but are not games: every such top-level page in lila's conf/routes.
  // Without this list, opening Puzzles or Practice counted as a game for the
  // moment the page took to load, and every other tab blinked.
  OX.notGames = ['analysis', 'bookmark', 'features', 'insights', 'markdown', 'password', 'practice', 'streamer', 'timeline', 'training'];

  // Lichess serves the forecast board for an active game here, and redirects
  // replayable games to their normal review page.
  OX.isGameForecastPath = pathname => /^\/game\/[A-Za-z0-9]{8}\/(?:white|black)\/analysis\/?$/.test(pathname);

  // main.analyse carries variant-<key>; features only make sense for these.
  OX.standardVariantClasses = ['variant-standard', 'variant-fromPosition'];
  // main.analyse carries this while a study chapter is an interactive lesson
  // (a quiz): nothing is shown there, so it can't give the answers away.
  OX.gamebookClass = 'gamebook-play';
})();
