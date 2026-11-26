// Opening and syncing your games, for the My games tab (features/mine.js):
// a Lichess game opens on its own Lichess page, a chess.com game on the
// analysis board, turned to your side, with its players and result ready
// for Lichess's "Study" button. No box of its own.
(() => {
  const OX = globalThis.OX;
  const KEY = 'ox.game';
  let orientedGame = null;

  function splitPgn(pgn) {
    const tag = /\s*\[\s*(\w+)\s+"((?:[^"\\\r\n]|\\[^\r\n])*)"\s*\]/y;
    const entries = [];
    let end = 0;
    for (let match; (match = tag.exec(pgn));) {
      entries.push([match[1], match[2]]);
      end = tag.lastIndex;
    }
    return { tags: Object.fromEntries(entries), moves: pgn.slice(end).trim() };
  }

  function studyTags(game) {
    const { tags } = splitPgn(game.pgn || '');
    const escape = value => (value || '').replace(/[\r\n]/g, ' ').replace(/["\\]/g, '\\$&');
    tags.White ||= escape(game.white);
    tags.Black ||= escape(game.black);
    tags.Result = game.result || tags.Result || '*';
    return tags;
  }

  // The analysis-board address of one of your games (its moves in the URL).
  function gamePath(game) {
    const chess = new globalThis.OXChess();
    chess.loadPgn(game.pgn || '', { strict: false });
    const sans = chess.history().map(san => san.replace(/[+#]/g, ''));
    return { path: `/analysis/pgn/${sans.map(encodeURIComponent).join('_')}`, plies: sans.length };
  }

  // Opens your game at `ply` (default: the end). A game played on Lichess
  // opens on its own Lichess page, from your side, with everything Lichess
  // keeps for it (computer analysis, the eval graph, your notes, the chat). A
  // chess.com game has no Lichess page, so it opens on the analysis board.
  OX.openMyGame = async (gameId, ply) => {
    const game = await OX.bridge.api('GET', `/games/${gameId}`);
    const lichessId = game.source === 'lichess'
      && /\[(?:GameId "|Site "https?:\/\/lichess\.org\/(?:game\/)?)([A-Za-z0-9]{8})"/.exec(game.pgn || '')?.[1];
    const { path, plies } = gamePath(game);
    if (lichessId) {
      // Lichess's game page opens at the first move without a ply: say the end.
      location.href = `/${lichessId}${game.user_color === 'black' ? '/black' : ''}#${ply ?? plies}`;
      return;
    }
    const hash = `#${ply ?? plies}`;
    try {
      const decoded = decodeURIComponent(path);
      const sameBoard = decodeURIComponent(location.pathname) === decoded;
      const attachingGame = sameBoard && Number(current()?.id) !== Number(gameId);
      sessionStorage.setItem(`${KEY}:${decoded}`, JSON.stringify({ id: Number(gameId), studyTags: studyTags(game) }));
      if (attachingGame) {
        // Changing only the fragment keeps the existing game card (or no
        // card at all). Remount it for the newly selected imported game.
        location.hash = hash;
        location.reload();
        return;
      }
    } catch { /* storage blocked */ }
    location.href = path + hash;
  };

  // Brings in your newest games from every account (chess.com and Lichess),
  // as the app's Sync button does. Reports partial failures as well as games
  // imported by the accounts that did finish.
  let syncing = null;
  OX.syncGames = (onProgress = () => {}) => {
    if (syncing) return syncing;
    syncing = (async () => {
      const accounts = await OX.bridge.api('GET', '/accounts');
      if (!accounts.length) throw new Error('No game accounts yet. Click the extension icon to add one.');
      onProgress('Syncing your games…');
      let jobs = await Promise.all(accounts.map(async account => {
        try { return { account, job: await OX.bridge.api('POST', `/accounts/${account.id}/sync`) }; }
        catch (error) { return { account, error }; }
      }));
      const started = Date.now();
      while (jobs.some(({ job }) => job?.status === 'queued' || job?.status === 'running')) {
        if (Date.now() - started > 5 * 60 * 1000) throw new Error('The sync is taking longer than expected. Check its progress in extension settings.');
        await new Promise(resolve => setTimeout(resolve, 1500));
        jobs = await Promise.all(jobs.map(async item => {
          const { job } = item;
          if (job?.status !== 'queued' && job?.status !== 'running') return item;
          try { return { ...item, job: await OX.bridge.api('GET', `/sync-jobs/${job.id}`), pollFailures: 0 }; }
          catch (error) {
            const pollFailures = (item.pollFailures || 0) + 1;
            // One missed reply does not mean the server-side job stopped.
            if (pollFailures < 3) return { ...item, pollFailures };
            return { ...item, job: { ...job, status: 'failed' }, error };
          }
        }));
        const seen = jobs.reduce((n, { job }) => n + (job?.seen || 0), 0);
        if (seen) onProgress(`Syncing your games… ${seen} looked at`);
      }
      const failures = jobs.flatMap(({ account, job, error }) => {
        const cause = error?.message || (job?.status === 'failed' ? job.error || 'sync failed' : job?.status === 'cancelled' ? 'cancelled' : null);
        return cause ? [`${account.username}: ${cause}`] : [];
      });
      const warnings = jobs.flatMap(({ account, job }) => (job?.warnings || []).map(warning => `${account.username}: ${warning}`));
      return { count: jobs.reduce((n, { job }) => n + (job?.imported || 0), 0), failures, warnings };
    })().finally(() => { syncing = null; });
    return syncing;
  };
  OX.syncedText = ({ count, failures = [], warnings = [] }) => {
    const base = count ? `${count} new game${count === 1 ? '' : 's'} synced`
      : failures.length ? 'No new games synced' : 'Up to date: no new games';
    const problems = [
      failures.length ? `${failures.length} account${failures.length === 1 ? '' : 's'} failed: ${failures.join('; ')}` : '',
      warnings.length ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}: ${warnings.join('; ')}` : '',
    ].filter(Boolean);
    return problems.length ? `${base}. ${problems.join('. ')}` : base;
  };
  OX.syncErrorText = error => (error.offline ? OX.offlineText() : error.status ? "Couldn't sync your games." : error.message);

  function current() {
    try {
      const path = decodeURIComponent(location.pathname);
      // As a number, like the app's own ids.
      const saved = JSON.parse(sessionStorage.getItem(`${KEY}:${path}`) || 'null');
      return saved?.id > 0 ? saved : null;
    } catch { return null; }
  }

  // A chess.com game opened from My games is shown on the analysis board (it
  // has no Lichess page of its own). Two things are done for it, with no box
  // on the page: the board turns to your side once, and Lichess's "Study"
  // button (which saves the board to a study) gets the game's players and
  // result, which the analysis board alone does not know.
  function attachOpenedGame() {
    const saved = current();
    if (!saved?.id) return;
    let importedTags = saved.studyTags || null;
    // Lichess writes the current move tree on submit. Add the imported
    // game's tags to the resulting form data, before Lichess's study picker.
    const addStudyTags = event => {
      if (!importedTags || !event.target.matches('form[method="post"][action="/study/as"]')) return;
      const data = event.formData;
      const pgn = data.get('pgn');
      if (typeof pgn !== 'string' || !pgn || data.get('gameId')) return;
      const { tags, moves } = splitPgn(pgn);
      const result = /^(?:1-0|0-1|1\/2-1\/2)$/.test(importedTags.Result) ? importedTags.Result : '*';
      const headers = { ...importedTags, ...tags, Result: result };
      const headerText = Object.entries(headers).map(([name, value]) => `[${name} "${value}"]`).join('\n');
      const moveText = moves.replace(/(?:^|\s)(?:1-0|0-1|1\/2-1\/2|\*)$/, '').trimEnd();
      data.set('pgn', `${headerText}\n\n${[moveText, result].filter(Boolean).join(' ')}`);
    };
    // Put in again after an extension update: replace the older copy's listener.
    if (globalThis.__oxStudyTags) document.removeEventListener('formdata', globalThis.__oxStudyTags);
    globalThis.__oxStudyTags = addStudyTags;
    document.addEventListener('formdata', addStudyTags);
    OX.bridge.api('GET', `/games/${saved.id}`).then(game => {
      importedTags ||= studyTags(game);
      // Lichess's controller may still be starting: try for a few seconds.
      let tries = 0;
      const turn = () => {
        if (orientedGame === saved.id) return;
        if (OX.lichess.showSide(game.user_color)) orientedGame = saved.id;
        else if (++tries < 10) setTimeout(turn, 500);
      };
      turn();
    }).catch(() => { /* the app is not running: the board stays as it is */ });
  }
  attachOpenedGame();
})();
