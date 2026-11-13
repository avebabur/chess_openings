// Lichess's opening explorer (with My games) shown in the left column instead
// of squeezing the move list on the right. Lichess's own element is not moved
// (its code updates it in place and would break): a space is reserved at the
// end of the left column and the explorer is drawn over it, positioned inside
// Lichess's right column (made not to clip it) so it scrolls with the page.
// The space never makes the left column taller than the board: on game pages
// Lichess's chat sits in its own row under the left column, and both must fit
// beside the board, or the whole page stretches (a big gap under the board).
// Only on wide layouts, where the left column sits beside the board.
(() => {
  const OX = globalThis.OX;
  const A = OX.anchors;
  const GAP = 12;

  OX.defineFeature({
    id: 'explorerleft',
    name: 'Opening explorer in the left column',
    pages: ['analyse'],
    anchors: ['side'],
    order: 4,
    place: { anchor: 'side', where: 'append', shadow: false, zeroHeightOk: true },

    create(host) {
      host.className = 'ox-explorer-space';
      let moved = null; // the explorer element currently shown on the left

      function release() {
        const chat = OX.$('main.analyse > .mchat');
        if (chat) chat.style.removeProperty('height');
        if (moved) {
          moved.classList.remove('ox-left');
          for (const prop of ['top', 'left', 'width', 'height']) moved.style.removeProperty(prop);
          moved = null;
        }
        host.style.height = '0px';
      }

      function place() {
        const main = OX.$(A.analysePage.selector);
        const box = OX.$(A.explorerBox.selector);
        const side = OX.$(A.side.selector);
        const board = OX.$('main.analyse .cg-wrap');
        const tools = box?.parentElement;
        if (!main || !box || !side || !board || !tools) return release();
        const sideRect = side.getBoundingClientRect();
        const boardRect = board.getBoundingClientRect();
        // Narrow layouts stack the columns: leave Lichess's layout alone.
        if (sideRect.right > boardRect.left || sideRect.width < 200) return release();
        if (moved && moved !== box) release();
        moved = box;
        box.classList.add('ox-left');
        const spaceTop = host.getBoundingClientRect().top + GAP;
        // Room down to the board's bottom, minus the chat row if there is one.
        const chat = OX.$('main.analyse > .mchat');
        const chatRoom = chat ? 180 + GAP : 0; // keep the chat usable (it shrinks to fit)
        const height = Math.max(200, boardRect.bottom - spaceTop - chatRoom);
        host.style.height = `${height + GAP}px`;
        const toolsRect = tools.getBoundingClientRect();
        box.style.top = `${spaceTop - toolsRect.top}px`;
        box.style.left = `${sideRect.left - toolsRect.left}px`;
        box.style.width = `${sideRect.width}px`;
        box.style.height = `${height}px`;
        // Lichess sizes the chat once, before these boxes appear, and never
        // shrinks it; give it exactly the room left beside the board.
        if (chat) {
          const room = Math.round(boardRect.bottom - sideRect.bottom);
          chat.style.height = `${Math.max(140, room)}px`;
        }
      }

      // Follow window resizing at once (scrolling needs nothing: the explorer
      // is part of the page).
      let frame = 0;
      const follow = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
      addEventListener('resize', follow, { passive: true });

      return {
        update() {},
        tick: place,
        destroy() {
          removeEventListener('resize', follow);
          release();
        },
      };
    },
  });
})();
