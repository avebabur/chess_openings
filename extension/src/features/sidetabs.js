// One panel with tabs in the left column — My game / Repertoire —
// instead of boxes stacked on top of each other (which made the column
// taller than the board and squeezed Lichess's chat and notes). The tab row
// looks like Lichess's own chat tabs. Each tab's content is still its own
// feature (game.js, repertoire.js); this only shows one at a time. Notes are
// Lichess's own (the Notes tab of its chat, and study comments).
(() => {
  const OX = globalThis.OX;
  const TABS = [
    { id: 'game', label: 'My game' },
    { id: 'repertoire', label: 'Repertoire' },
  ];
  // available: the feature has something to show.
  const info = { game: { available: false }, repertoire: { available: true } };
  let picked = null; // the tab chosen on this page
  const hostOf = id => document.querySelector(`[data-ox-host="${id}"]`);
  const usable = () => TABS.filter(tab => info[tab.id].available && hostOf(tab.id));

  OX.sidePanel = {
    set(id, patch) { Object.assign(info[id], patch); OX.emit('sidepanel'); },
    // The tab picked on this page; else your game's when one is open.
    active() {
      const ids = usable().map(tab => tab.id);
      if (picked && ids.includes(picked)) return picked;
      return ids.includes('game') ? 'game' : ids[0] || null;
    },
    activeHost() {
      const id = OX.sidePanel.active();
      return id ? hostOf(id) : null;
    },
    pick(id) {
      picked = id;
      OX.emit('sidepanel');
    },
  };

  OX.defineFeature({
    id: 'sidetabs',
    name: 'Left column tabs',
    pages: ['analyse'],
    anchors: ['side'],
    order: 1.5,
    place: { anchor: 'side', where: 'append', zeroHeightOk: true },

    create(host, root) {
      root.classList.add('tabsbar');
      root.setAttribute('role', 'tablist');
      let alive = true;
      let drawn = '';

      function draw() {
        if (!alive) return;
        const shown = usable();
        const active = OX.sidePanel.active();
        const tabbed = shown.length > 1;
        for (const tab of TABS) {
          const panel = hostOf(tab.id);
          if (!panel) continue;
          const display = tab.id === active ? '' : 'none';
          if (panel.style.display !== display) panel.style.display = display;
          panel.classList.toggle('ox-tabbed', tabbed);
        }
        const signature = JSON.stringify([active, shown.map(tab => tab.id)]);
        if (signature === drawn) return;
        drawn = signature;
        root.style.display = tabbed ? '' : 'none';
        root.replaceChildren(...shown.map(tab => OX.el('button', {
          class: `tab${tab.id === active ? ' active' : ''}`, role: 'tab', 'aria-selected': String(tab.id === active),
          onclick: () => OX.sidePanel.pick(tab.id),
        }, tab.label)));
      }
      const stopListening = OX.on('sidepanel', draw);

      return {
        tick: draw,
        destroy() {
          alive = false;
          stopListening();
          for (const tab of TABS) {
            const panel = hostOf(tab.id);
            if (panel) { panel.style.display = ''; panel.classList.remove('ox-tabbed'); }
          }
        },
      };
    },
  });
})();
