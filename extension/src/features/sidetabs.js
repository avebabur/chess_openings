// One panel with tabs in the left column instead of boxes stacked on top of
// each other (which made the column taller than the board and squeezed
// Lichess's chat and notes). The tab row looks like Lichess's own chat tabs
// and shows only when there are two tabs or more; today Repertoire is the
// only one, so no tab row appears. Notes are Lichess's own (the Notes tab of
// its chat, and study comments).
(() => {
  const OX = globalThis.OX;
  const TABS = [
    { id: 'repertoire', label: 'Repertoire' },
  ];
  // available: the feature has something to show.
  const info = { repertoire: { available: true } };
  let picked = null; // the tab chosen on this page
  const hostOf = id => document.querySelector(`[data-ox-host="${id}"]`);
  const usable = () => TABS.filter(tab => info[tab.id].available && hostOf(tab.id));

  OX.sidePanel = {
    set(id, patch) { Object.assign(info[id], patch); OX.emit('sidepanel'); },
    // The tab picked on this page, else the first one.
    active() {
      const ids = usable().map(tab => tab.id);
      if (picked && ids.includes(picked)) return picked;
      return ids[0] || null;
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
      const buttons = new Map(TABS.map(tab => [tab.id, OX.el('button', {
        type: 'button', class: 'tab', role: 'tab', onclick: () => OX.sidePanel.pick(tab.id),
      }, tab.label)]));

      root.addEventListener('keydown', event => {
        const shown = usable();
        const from = shown.findIndex(tab => buttons.get(tab.id) === event.target);
        if (from < 0) return;
        let next;
        switch (event.key) {
          case 'ArrowRight': next = (from + 1) % shown.length; break;
          case 'ArrowLeft': next = (from + shown.length - 1) % shown.length; break;
          case 'Home': next = 0; break;
          case 'End': next = shown.length - 1; break;
          default: return;
        }
        event.preventDefault();
        event.stopPropagation();
        OX.sidePanel.pick(shown[next].id);
        buttons.get(shown[next].id).focus();
      });

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
        for (const { id } of shown) {
          const button = buttons.get(id);
          const selected = id === active;
          if (button.getAttribute('aria-selected') !== String(selected)) {
            button.classList.toggle('active', selected);
            button.setAttribute('aria-selected', String(selected));
            button.tabIndex = selected ? 0 : -1;
          }
        }
        const signature = shown.map(tab => tab.id).join(',');
        if (signature === drawn) return;
        drawn = signature;
        root.style.display = tabbed ? '' : 'none';
        root.replaceChildren(...shown.map(tab => buttons.get(tab.id)));
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
