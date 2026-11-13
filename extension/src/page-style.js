// Styles that change Lichess's own layout (everything else lives in shadow
// roots). Kept small and namespaced with "ox".
(() => {
  const OX = (globalThis.OX = globalThis.OX || {});

  OX.pageCss = `
/* Your app's board (#EAE9D2 / #4B729A, frontend/public/board/blue-flat.svg)
   on every Lichess board, whatever board theme Lichess is set to. Lichess
   paints its theme in cg-board::before, so that layer is replaced too. */
cg-board::before, cg-board { background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 8 8%22 shape-rendering=%22crispEdges%22%3E%3Crect width=%228%22 height=%228%22 fill=%22%23EAE9D2%22/%3E%3Cpath fill=%22%234B729A%22 d=%22M1 0h1v1h-1zM3 0h1v1h-1zM5 0h1v1h-1zM7 0h1v1h-1zM0 1h1v1h-1zM2 1h1v1h-1zM4 1h1v1h-1zM6 1h1v1h-1zM1 2h1v1h-1zM3 2h1v1h-1zM5 2h1v1h-1zM7 2h1v1h-1zM0 3h1v1h-1zM2 3h1v1h-1zM4 3h1v1h-1zM6 3h1v1h-1zM1 4h1v1h-1zM3 4h1v1h-1zM5 4h1v1h-1zM7 4h1v1h-1zM0 5h1v1h-1zM2 5h1v1h-1zM4 5h1v1h-1zM6 5h1v1h-1zM1 6h1v1h-1zM3 6h1v1h-1zM5 6h1v1h-1zM7 6h1v1h-1zM0 7h1v1h-1zM2 7h1v1h-1zM4 7h1v1h-1zM6 7h1v1h-1z%22/%3E%3C/svg%3E") !important; background-size: cover !important; }

/* The WikiBook is not needed; your repertoire and game take its place. */
#wikibook-field, main.analyse .analyse__wiki { display: none !important; }

/* The opening explorer shown in the left column (features/explorerleft.js):
   out of the right column's flow, drawn over the space reserved for it. */
main.analyse .analyse__tools:has(> section.explorer-box.ox-left) { overflow: visible !important; }
main.analyse:has(section.explorer-box.ox-left) > .mchat { display: flex; flex-direction: column; overflow: hidden; }
main.analyse:has(section.explorer-box.ox-left) > .mchat > .mchat__content { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
main.analyse section.explorer-box.ox-left { position: absolute !important; z-index: 2; margin: 0 !important;
  max-height: none !important; border-radius: 6px; overflow-y: auto; }
.ox-explorer-space { display: block; }

/* My games replaces Lichess's Player tab: it holds the same Lichess games
   (imported by the app) plus chess.com, as one history. */
.explorer-title .player { display: none !important; }

/* "My games" tab inside Lichess's opening explorer: while it is chosen,
   Lichess's own tables give way to yours (the tab row stays). */
.explorer-box.ox-mine .data > :not(.explorer-title):not(.ox-mine-content) { display: none !important; }
.explorer-box:not(.ox-mine) .ox-mine-content { display: none !important; }
.explorer-box.ox-mine .explorer-title .active { opacity: .6; }
.explorer-box.ox-mine .explorer-title .active strong { font-weight: normal; }
.explorer-title .ox-tab.ox-active { font-weight: bold; color: var(--c-font-clear, var(--c-font)); text-decoration: none; }
.ox-mine-content .ox-mine-head { display: flex; gap: .6em; align-items: center; justify-content: space-between;
  padding: .3em .5em; font-size: .9em; color: var(--c-font-dim); }
.ox-mine-content .ox-mine-head button { color: var(--c-primary); background: none; border: 0; cursor: pointer; padding: 0; font: inherit; }
.ox-mine-content .ox-mine-head .ox-sync { flex: none; white-space: nowrap; }
.ox-mine-content .ox-mine-head .ox-sync:disabled { opacity: .5; cursor: default; }
.ox-mine-content tbody tr { cursor: pointer; }
.ox-mine-content .ox-empty { padding: 1.2em 1em; text-align: center; color: var(--c-font-dim); font-style: italic; }
.ox-mine-content .ox-more { display: block; width: 100%; margin: .4em 0; }
.ox-mine-content td.ox-res-win { color: var(--c-good); }
.ox-mine-content td.ox-res-loss { color: var(--c-bad); }
`;

  OX.injectPageStyle = () => {
    const parent = document.head || document.documentElement;
    if (!parent) {
      // Not even <html> yet: try again once the page has started.
      document.addEventListener('DOMContentLoaded', OX.injectPageStyle, { once: true });
      return;
    }
    // An updated copy replaces the style an older copy added.
    document.getElementById('ox-page-style')?.remove();
    const style = document.createElement('style');
    style.id = 'ox-page-style';
    style.textContent = OX.pageCss;
    parent.append(style);
  };
})();
