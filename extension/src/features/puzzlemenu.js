// "From my games" in Lichess's own Puzzles menu (top bar), next to Puzzles,
// Puzzle Themes, Puzzle Dashboard… It opens Lichess's puzzle page at the
// Your mistakes box (features/puzzles.js). A link inside Lichess, so it stays
// during games.
(() => {
  const OX = globalThis.OX;

  OX.defineFeature({
    id: 'puzzlemenu',
    name: 'From my games (Puzzles menu)',
    pages: ['analyse', 'round', 'puzzle', 'other'],
    pauses: false,
    anchors: ['puzzleMenu'],
    order: 1,
    place: { anchor: 'puzzleMenu', where: 'append', shadow: false, tag: 'a', zeroHeightOk: true },

    create(host) {
      host.href = '/training#ox-mistakes';
      host.textContent = 'From my games';
      return {};
    },
  });
})();
