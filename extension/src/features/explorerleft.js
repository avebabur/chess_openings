// Keeps the left column no taller than the board, and shows Lichess's opening
// explorer (with My games) there instead of squeezing the move list.
//
// A left column taller than the board stretches Lichess's whole page: a gap
// opens under the board and, on game pages, the chat (with Lichess's Notes
// tab) is squeezed to a sliver. So the repertoire box gets a height limit and
// scrolls inside itself.
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
  const EXPLORER_MIN = 200;
  const EXPLORER_PREFERRED = 260;
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
      // place() runs on every tick: write a style only when it changes (an
      // unchanged write still counts as a change to the page).
      const setStyle = (el, prop, value) => {
        if (value == null) { if (el.style.getPropertyValue(prop)) el.style.removeProperty(prop); }
        else if (el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value);
      };
      // Rounded as Chrome reads a length back, so an unchanged one compares equal.
      const px = n => `${Math.round(n * 100) / 100}px`;
      let moved = null;   // the explorer element currently shown on the left
      let limited = null; // the panel host that has a height limit

      function limit(panel, height) {
        if (limited && limited !== panel) setStyle(limited, '--ox-max', null);
        limited = panel;
        if (panel) setStyle(panel, '--ox-max', height == null ? null : `${Math.round(height)}px`);
      }

      // Lichess gives its chat a fixed height, sized for its own short left
      // column; under our panel that reaches past the board and stretches the
      // page. Give it exactly the room left beside the board.
      let fitted = null;
      function fitChat(chat, height) {
        if (fitted && fitted !== chat) { fitted.classList.remove('ox-fit'); setStyle(fitted, 'height', null); }
        fitted = chat;
        if (!chat) return;
        if (!chat.classList.contains('ox-fit')) chat.classList.add('ox-fit');
        setStyle(chat, 'height', `${Math.round(height)}px`);
      }

      // The explorer goes back to Lichess's place; the space left is `space` high.
      function release(space = '0px') {
        if (moved) {
          moved.classList.remove('ox-left');
          for (const prop of ['top', 'left', 'width', 'height']) setStyle(moved, prop, null);
          moved = null;
        }
        setStyle(host, 'height', space);
      }

      function place() {
        const main = OX.$(A.analysePage.selector);
        const side = OX.$(A.side.selector);
        const board = OX.$('main.analyse .cg-wrap');
        const panel = OX.$('[data-ox-host="repertoire"]');
        if (!main || !side || !board) { limit(null); fitChat(null); return release(); }
        const sideRect = side.getBoundingClientRect();
        const boardRect = board.getBoundingClientRect();
        // Narrow layouts stack the columns: leave Lichess's layout alone.
        if (sideRect.right > boardRect.left || sideRect.width < 200) { limit(panel, null); fitChat(null); return release(); }

        const chat = OX.$('main.analyse > .mchat');
        const panelTop = panel?.getBoundingClientRect().top;
        const available = boardRect.bottom - (panelTop ?? host.getBoundingClientRect().top);
        const canMoveExplorer = !chat && available >= (panel ? PANEL_MIN : 0) + EXPLORER_MIN + GAP;
        const box = canMoveExplorer ? OX.$(A.explorerBox.selector) : null;
        const tools = box?.parentElement;
        const bottom = boardRect.bottom - (chat ? CHAT_MIN + GAP : 0);
        if (panel) {
          const reserved = box && tools ? Math.min(EXPLORER_PREFERRED, available - PANEL_MIN - GAP) + GAP : 0;
          limit(panel, Math.max(PANEL_MIN, bottom - panelTop - reserved));
        } else limit(null);

        if (!box || !tools) {
          // A little air between the panel and Lichess's chat.
          release(chat ? `${GAP}px` : '0px');
          return fitChat(chat, chat ? Math.max(140, boardRect.bottom - chat.getBoundingClientRect().top) : 0);
        }
        fitChat(null);
        if (moved && moved !== box) release();
        moved = box;
        if (!box.classList.contains('ox-left')) box.classList.add('ox-left');
        const spaceTop = host.getBoundingClientRect().top + GAP;
        const height = Math.max(EXPLORER_MIN, bottom - spaceTop);
        setStyle(host, 'height', px(height + GAP));
        const toolsRect = tools.getBoundingClientRect();
        setStyle(box, 'top', px(spaceTop - toolsRect.top));
        setStyle(box, 'left', px(sideRect.left - toolsRect.left));
        setStyle(box, 'width', px(sideRect.width));
        setStyle(box, 'height', px(height));
      }

      // Follow window resizing at once (scrolling needs
      // nothing: the explorer is part of the page).
      let frame = 0;
      let alive = true;
      const follow = () => { if (!alive) return; cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
      addEventListener('resize', follow, { passive: true });

      return {
        update() {},
        tick: place,
        destroy() {
          alive = false;
          cancelAnimationFrame(frame);
          removeEventListener('resize', follow);
          limit(null);
          fitChat(null);
          release();
        },
      };
    },
  });
})();
