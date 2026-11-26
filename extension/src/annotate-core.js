// Your own analysis of a study chapter, turned into what Lichess's "Publish"
// takes (lila ui/analyse/src/local/localAnalysisEngine.ts, the request behind
// "Analyse on your device" -> Publish). Lichess then marks the moves itself:
// ?!, ?, ??, "X was best" with its line, and the accuracy chart.
//
// The results are the ones Lichess already holds for each move of the
// chapter's main line: what your Stockfish found while you stepped through
// the moves (as deep as you let it, "+" included), or Lichess's cloud where
// it used that. Nothing is searched here.
//
// Pure logic, no page access: tested by scripts/annotate-test.mjs.
(() => {
  const OX = (globalThis.OX = globalThis.OX || {});
  const LINE_PLIES = 12;       // Lichess's longest line (Info.LineMaxPlies)
  const INT32 = 2 ** 31 - 1;   // Lichess reads nodesPerMove as a 32-bit int
  // Lichess keeps every engine result in the browser and puts it back on the
  // moves when the chapter is opened again, also the depth-1 line of a search
  // cancelled a millisecond after it started (stepping on quickly). A result
  // this shallow says nothing about the move; a mate found holds at any depth.
  const MIN_DEPTH = 12;

  // lila WinPercent.winningChances: centipawns -> -1..1.
  const winningChances = cp => Math.max(-1, Math.min(1, 2 / (1 + Math.exp(-0.00368208 * cp)) - 1));
  const isNum = value => typeof value === 'number' && Number.isFinite(value);

  // What Lichess will call the move from `before` to `after` (scores from
  // White's side: { cp } or { mate }, mate > 0 White mates), as lila's
  // Advice.scala does: 'Inaccuracy', 'Mistake', 'Blunder' or null. Only a
  // move it judges gets a line: Lichess adds one for every move that has it.
  function judgment(before, after, moverWhite) {
    if (after.mate === 0) return null; // the move gave checkmate
    if (isNum(before.cp) && isNum(after.cp)) {
      const delta = winningChances(after.cp) - winningChances(before.cp);
      const loss = moverWhite ? -delta : delta;
      if (loss >= 0.3) return 'Blunder';
      if (loss >= 0.2) return 'Mistake';
      if (loss >= 0.1) return 'Inaccuracy';
      return null;
    }
    const sign = moverWhite ? 1 : -1;
    const prevMate = isNum(before.mate) ? before.mate * sign : null;
    const nowMate = isNum(after.mate) ? after.mate * sign : null;
    const prevCp = isNum(before.cp) ? before.cp * sign : 0;
    const nowCp = isNum(after.cp) ? after.cp * sign : 0;
    if (prevMate === null && nowMate !== null && nowMate < 0) { // checkmate is now unavoidable
      return prevCp < -999 ? 'Inaccuracy' : prevCp < -700 ? 'Mistake' : 'Blunder';
    }
    if (prevMate !== null && prevMate > 0 && (nowMate === null || nowMate < 0)) { // lost a forced mate
      return nowCp > 999 ? 'Inaccuracy' : nowCp > 700 ? 'Mistake' : 'Blunder';
    }
    return null;
  }

  // Plays a UCI move, castling written either way (e1g1, or e1h1 as
  // Stockfish writes it in Chess960 mode). The chess.js move, or null.
  function playUci(chess, uci) {
    if (typeof uci !== 'string' || uci.length < 4) return null;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci[4];
    try { return chess.move({ from, to, promotion }); } catch { /* not that move */ }
    const piece = chess.get(from);
    const target = chess.get(to);
    if (piece?.type === 'k' && target?.type === 'r' && target.color === piece.color) {
      try { return chess.move({ from, to: `${to > from ? 'g' : 'c'}${from[1]}` }); } catch { /* illegal */ }
    }
    return null;
  }

  const uciOf = move => move.from + move.to + (move.promotion || '');

  // A finished position's score: checkmate is mate 0, stalemate and bare
  // kings a draw. null while play goes on.
  function terminalScore(fen) {
    try {
      const chess = new globalThis.OXChess(fen);
      if (chess.isCheckmate()) return { mate: 0, terminal: true };
      if (chess.isStalemate() || chess.isInsufficientMaterial()) return { cp: 0, terminal: true };
    } catch { /* not a position chess.js reads */ }
    return null;
  }

  // One position's score: your engine's (or the cloud's) result, else the
  // finished position's, else what an earlier publish left on the chapter.
  const usable = e => !!e && Array.isArray(e.pv) && e.pv.length > 0 && (isNum(e.cp) || isNum(e.mate));
  const tooShallow = e => usable(e) && !isNum(e.mate) && (e.depth || 0) < MIN_DEPTH;

  function scoreOf(node) {
    const e = node.ceval;
    if (usable(e) && !tooShallow(e)) {
      return { ...(isNum(e.mate) ? { mate: e.mate } : { cp: e.cp }), pv: e.pv, depth: e.depth || 0,
        nodes: e.cloud ? 0 : e.nodes || 0, engineId: e.engineId || null };
    }
    const done = terminalScore(node.fen);
    if (done) return done;
    const old = node.eval;
    if (old && (isNum(old.cp) || isNum(old.mate))) {
      return { ...(isNum(old.mate) ? { mate: old.mate } : { cp: old.cp }), pv: old.best ? [old.best] : [], depth: 0, nodes: 0 };
    }
    return null;
  }

  // "12. Qd2" / "12… Qd2" for the move that led to a position of ply `ply`.
  const moveLabel = (ply, san) => `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '…'} ${san}`;

  // Where the chapter stands: how many of its moves have a result, which
  // don't, and the shallowest one (your engine's, at its depth).
  function status(data) {
    const moves = (data?.nodes || []).slice(1);
    const missing = [];
    let shallowest = null;
    for (const node of moves) {
      const score = scoreOf(node);
      if (!score) {
        const shallow = tooShallow(node.ceval) ? { depth: node.ceval.depth || 0 } : {};
        missing.push({ ply: node.ply, label: moveLabel(node.ply, node.san), ...shallow });
        continue;
      }
      if (score.depth && (!shallowest || score.depth < shallowest.depth)) {
        shallowest = { ply: node.ply, label: moveLabel(node.ply, node.san), depth: score.depth };
      }
    }
    return {
      total: moves.length,
      analysed: moves.length - missing.length,
      missing,
      shallowest,
      ready: moves.length > 0 && missing.length === 0,
      annotated: moves.some(node => node.eval && (isNum(node.eval.cp) || isNum(node.eval.mate))),
    };
  }

  const docScore = score => (score.mate === 0 ? { mate: 0, mateGiven: false }
    : isNum(score.mate) ? { mate: score.mate } : { cp: Math.round(score.cp) });

  // The analysis in the shape POST /analysis/publish takes. Throws if a move
  // has no result yet (status().ready says so first).
  function build(data, now = new Date()) {
    const nodes = data.nodes;
    const scores = nodes.map(scoreOf);
    const infos = [];
    for (let i = 1; i < nodes.length; i++) {
      const before = scores[i - 1];
      const after = scores[i];
      if (!after) throw new Error(`No result for ${moveLabel(nodes[i].ply, nodes[i].san)}`);
      const entry = { ply: nodes[i].ply, eval: docScore(after), variation: [] };
      const moverWhite = nodes[i - 1].fen.split(' ')[1] === 'w';
      if (before && before.pv?.length && judgment(before, after, moverWhite)) {
        const chess = new globalThis.OXChess(nodes[i - 1].fen);
        const line = [];
        for (const uci of before.pv.slice(0, LINE_PLIES)) {
          const move = playUci(chess, uci);
          if (!move) break;
          line.push(move);
        }
        const played = new globalThis.OXChess(nodes[i - 1].fen);
        const playedMove = playUci(played, nodes[i].uci);
        if (line.length && (!playedMove || uciOf(line[0]) !== uciOf(playedMove))) {
          entry.eval.best = uciOf(line[0]);
          entry.variation = line.map(move => move.san);
        }
      }
      infos.push(entry);
    }
    const searched = scores.filter(score => score?.nodes);
    const nodesPerMove = searched.length
      ? Math.min(INT32, Math.round(searched.reduce((sum, score) => sum + score.nodes, 0) / searched.length)) : 0;
    const engines = scores.map(score => score?.engineId).filter(Boolean);
    const doc = {
      id: data.chapterId,
      studyId: data.studyId,
      infos,
      startPly: nodes[0].ply,
      date: now.toISOString(),
      engine: { nodesPerMove, id: engines[0] || 'external', userId: data.user || '', engineVersion: 'Your Stockfish' },
    };
    if (scores[0]) doc.initialEval = docScore(scores[0]);
    return doc;
  }

  // --- Deep analysis (backend/deep_analysis.py) --------------------------------
  // The chapter's main line as POST /api/deep-analysis takes it, or null when
  // a move has no UCI (Lichess not ready yet).
  function chapterRequest(data, paused = false) {
    const nodes = data?.nodes || [];
    if (!data?.chapterId || nodes.length < 2) return null;
    const moves = nodes.slice(1).map(node => node.uci);
    if (moves.some(uci => typeof uci !== 'string')) return null;
    return { pageId: data.chapterId, initialFen: nodes[0].fen, moves, paused: !!paused };
  }

  // Pieces, side to move, castling: Lichess may write an en passant square
  // the service leaves out. Results are matched by ply as well.
  const epd = fen => String(fen || '').split(' ').slice(0, 3).join(' ');
  const resultFor = (results, node) => (results || []).find(r => r.ply === node.ply && epd(r.fen) === epd(node.fen));

  // The finished results Stockfish found, for page-bridge.js setEvals (the
  // engine bar and arrows on each move). The cloud's are left out: Lichess
  // puts its own cloud evaluation on the moves itself.
  function engineEvals(results) {
    return (results || []).filter(r => r.complete && r.source === 'engine' && Array.isArray(r.pv) && r.pv.length)
      .map(r => ({ ply: r.ply, fen: r.fen, depth: r.depth, cp: r.cp, mate: r.mate, nodes: r.nodes,
        millis: Math.round((r.seconds || 0) * 1000), pv: r.pv }));
  }

  // The chapter as read from the page, with each move's result replaced by
  // the deep one where that is finished and deeper: what is published.
  function withResults(data, results, engineId = null) {
    if (!data) return data;
    const nodes = data.nodes.map(node => {
      const r = resultFor(results, node);
      if (!r || !r.complete || !Array.isArray(r.pv) || !r.pv.length || (!isNum(r.cp) && !isNum(r.mate))) return node;
      const old = node.ceval;
      if (usable(old) && !tooShallow(old) && (old.depth || 0) > r.depth) return node;
      const cloud = r.source === 'cloud';
      return { ...node, ceval: { cp: isNum(r.cp) ? r.cp : null, mate: isNum(r.mate) ? r.mate : null, depth: r.depth,
        nodes: r.nodes || 0, engineId: cloud ? null : engineId, cloud, pv: r.pv.slice(0, LINE_PLIES) } };
    });
    return { ...data, nodes };
  }

  // What a publish was made from: published again only when this changes
  // (moves added to the chapter, a deeper result).
  function signature(data) {
    return JSON.stringify([data?.chapterId, (data?.nodes || []).map(n => [n.uci, n.ceval?.depth ?? null])]);
  }

  OX.annotate = { judgment, status, build, moveLabel, playUci, MIN_DEPTH,
    chapterRequest, engineEvals, withResults, signature };
})();
