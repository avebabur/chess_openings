// Keeps the left column no taller than the board, and shows Lichess's opening
// explorer (with My games) there instead of squeezing the move list.
//
// A left column taller than the board stretches Lichess's whole page: a gap
// opens under the board and, on game pages, the chat (with Lichess's Notes
// tab) is squeezed to a sliver. So the open tab of the panel (sidetabs.js)
// gets a height limit and scrolls inside itself.
//
// The explorer: Lichess's own element is not moved (its code updates it in
// place and would break). A space is reserved at the end of the left column
// and the explorer is drawn over it, positioned inside Lichess's right column
// (made not to clip it) so it scrolls with the page. Only on wide layouts,
// where the left column sits beside the board, and only on pages without a
// chat: on game pages and studies the room under the panel belongs to
// Lichess's chat and notes, so the explorer stays where Lichess puts it.
(() => {
  const OX = globalThis.OX;
  const A = OX.anchors;
  const GAP = 12;
  const PANEL_MIN = 150;    // the panel never gets less than this
  const EXPLORER_MIN = 260; // room kept for the explorer while it is open
  const CHAT_MIN = 190;     // room kept for Lichess's chat / notes

  OX.defineFeature({
    id: 'explorerleft',
    name: 'Opening explorer in the left column',
    pages: ['analyse'],
    anchors: ['side'],
    order: 4,
    place: { anchor: 'side', where: 'append', shadow: false, zeroHeightOk: true },

    create(host) {
      host.className = 'ox-explorer-space';
      let moved = null;   // the explorer element currently shown on the left
      let limited = null; // the panel host that has a height limit

      function limit(panel, height) {
        if (limited && limited !== panel) limited.style.removeProperty('--ox-max');
        limited = panel;
        if (!panel) return;
        if (height == null) panel.style.removeProperty('--ox-max');
        else panel.style.setProperty('--ox-max', `${Math.round(height)}px`);
      }

      // Lichess gives its chat a fixed height, sized for its own short left
      // column; under our panel that reaches past the board and stretches the
      // page. Give it exactly the room left beside the board.
      let fitted = null;
      function fitChat(chat, height) {
        if (fitted && fitted !== chat) { fitted.classList.remove('ox-fit'); fitted.style.removeProperty('height'); }
        fitted = chat;
        if (!chat) return;
        chat.classList.add('ox-fit');
        chat.style.height = `${Math.round(height)}px`;
      }

      function release() {
        if (moved) {
          moved.classList.remove('ox-left');
          for (const prop of ['top', 'left', 'width', 'height']) moved.style.removeProperty(prop);
          moved = null;
        }
        host.style.height = '0px';
      }

      function place() {
        const main = OX.$(A.analysePage.selector);
        const side = OX.$(A.side.selector);
        const board = OX.$('main.analyse .cg-wrap');
        const panel = OX.sidePanel?.activeHost() || null;
        if (!main || !side || !board) { limit(null); fitChat(null); return release(); }
        const sideRect = side.getBoundingClientRect();
        const boardRect = board.getBoundingClientRect();
        // Narrow layouts stack the columns: leave Lichess's layout alone.
        if (sideRect.right > boardRect.left || sideRect.width < 200) { limit(panel, null); fitChat(null); return release(); }

        const chat = OX.$('main.analyse > .mchat');
        const box = chat ? null : OX.$(A.explorerBox.selector);
        const tools = box?.parentElement;
        const bottom = boardRect.bottom - (chat ? CHAT_MIN + GAP : 0);
        if (panel) {
          const reserved = box && tools ? EXPLORER_MIN + GAP : 0;
          limit(panel, Math.max(PANEL_MIN, bottom - panel.getBoundingClientRect().top - reserved));
        } else limit(null);

        if (!box || !tools) {
          release();
          // A little air between the panel and Lichess's chat.
          if (chat) host.style.height = `${GAP}px`;
          return fitChat(chat, chat ? Math.max(140, boardRect.bottom - chat.getBoundingClientRect().top) : 0);
        }
        fitChat(null);
        if (moved && moved !== box) release();
        moved = box;
        box.classList.add('ox-left');
        const spaceTop = host.getBoundingClientRect().top + GAP;
        const height = Math.max(200, bottom - spaceTop);
        host.style.height = `${height + GAP}px`;
        const toolsRect = tools.getBoundingClientRect();
        box.style.top = `${spaceTop - toolsRect.top}px`;
        box.style.left = `${sideRect.left - toolsRect.left}px`;
        box.style.width = `${sideRect.width}px`;
        box.style.height = `${height}px`;
      }

      // Follow window resizing and tab changes at once (scrolling needs
      // nothing: the explorer is part of the page).
      let frame = 0;
      let alive = true;
      const follow = () => { if (!alive) return; cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
      addEventListener('resize', follow, { passive: true });
      const stopListening = OX.on('sidepanel', follow);

      return {
        update() {},
        tick: place,
        destroy() {
          alive = false;
          cancelAnimationFrame(frame);
          stopListening();
          removeEventListener('resize', follow);
          limit(null);
          fitChat(null);
          release();
        },
      };
    },
  });
})();
