// Styles for the added boxes. They live inside each box's shadow root, so they
// cannot leak into Lichess and Lichess's CSS cannot break them. Colours come
// from Lichess's own theme variables, and the shapes (15px corners, the box
// shadow, uppercase buttons, the tab row) are copied from Lichess's own side
// boxes, chat tabs and buttons, so light, dark and transparent themes match.
(() => {
  const OX = (globalThis.OX = globalThis.OX || {});
  OX.css = `
:host { display: block; flex: 0 0 auto; }
.ox {
  font: inherit; font-size: 14px; line-height: 1.4;
  color: var(--c-font, #4d4d4d);
  background: var(--c-bg-box, #fff);
  border-top: 1px solid var(--c-border, #d9d9d9);
  padding: 6px 10px 7px;
}
.ox [hidden] { display: none !important; }
.head { display: flex; align-items: center; gap: 8px; min-height: 22px; }
.title { font-weight: 600; color: var(--c-font-clear, inherit); }
.grow { flex: 1 1 auto; min-width: 0; }
.dim { color: var(--c-font-dim, #787878); }
.small { font-size: 12.5px; }
.ok { color: var(--c-good, #629924); }
.bad { color: var(--c-bad, #c33); }
.offline { color: var(--c-font-dim, #787878); font-style: italic; }
.row { margin-top: 6px; }
.ellipsis { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
a { color: var(--c-primary, #1b78d0); text-decoration: none; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.ox button:focus-visible, .ox input:focus-visible, .ox select:focus-visible {
  outline: 2px solid var(--c-primary, #1b78d0); outline-offset: 1px;
}

/* ---- A box in Lichess's left column ---- */
.ox.card {
  box-sizing: border-box; border: 0; border-radius: 15px; margin-top: 12px; padding: 12px 16px 14px;
  box-shadow: 0 2px 2px 0 rgba(0,0,0,.08), 0 3px 1px -2px rgba(0,0,0,.18), 0 1px 5px 0 rgba(0,0,0,.1);
  max-height: var(--ox-max, none); overflow-y: auto; scrollbar-width: thin;
}
/* Under the tab row (features/sidetabs.js): joined to it, like Lichess's chat. */
:host(.ox-tabbed) .ox.card { margin-top: 0; border-radius: 0 0 15px 15px; }
.ox.tabsbar { display: flex; margin-top: 12px; padding: 0; border: 0; background: none; }
.tab { flex: 1 1 0; min-width: 0; padding: 5.6px 8px; text-align: center; white-space: nowrap; font-weight: 300;
  color: var(--c-font-dim, #787878); border-radius: 15px 15px 0 0; transition: color .12s; }
.tab:hover { color: var(--c-font-clear, inherit); }
.tab.active { color: var(--c-font, inherit); background: var(--c-bg-box, #fff); }

/* ---- Buttons, as Lichess's .button / .button-empty ---- */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 12px; border-radius: 15px;
  font-size: 12px; font-weight: 500; text-transform: uppercase; white-space: nowrap;
  color: var(--c-primary, #1b78d0); transition: background .15s, color .15s; }
.btn:not(.primary):not(.danger) { padding-left: 2px; padding-right: 2px; }
.btn:not(.primary):not(.danger):hover { filter: brightness(1.25); }
.btn.primary { background: var(--c-primary, #1b78d0); color: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
.btn.primary:hover { filter: brightness(1.1); }
.btn.danger { background: var(--c-bad, #c33); color: #fff; }
.btn:disabled { opacity: .55; cursor: default; }
.btns { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 10px; }
.btns.sticky { position: sticky; bottom: -14px; margin: 0 -16px -14px; padding: 10px 16px 12px; background: var(--c-bg-box, #fff); }
.link { color: var(--c-primary, #1b78d0); }
.link:hover { text-decoration: underline; }
.ox-svg-icon { display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; }
.ox-svg-icon svg { display: block; }

/* ---- Rows that run edge to edge with Lichess's zebra stripes ---- */
.list { margin: 8px -16px 0; }
.list > * { display: flex; align-items: center; gap: 10px; box-sizing: border-box; width: 100%; padding: 6px 16px; text-align: left; }
.list > :nth-child(odd) { background: var(--c-bg-zebra, rgba(127,127,127,.08)); }
.list > .mistake { cursor: pointer; }
.list > .mistake:hover { background: var(--c-bg-zebra2, rgba(127,127,127,.16)); }
.mistake .san { flex: 0 0 auto; min-width: 5.2em; font-weight: 700; color: var(--c-font-clear, inherit); }
.subhead { display: flex; align-items: baseline; gap: 6px; margin-top: 12px; font-weight: 600; color: var(--c-font-clear, inherit); }
.subhead .dim { font-weight: 400; }

/* ---- Repertoire ---- */
.rep .section + .section, .rep .section + .footer, .rep .banner + .section { margin-top: 12px; }
.rep .section-head { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
.rep .section-title { font-weight: 600; color: var(--c-font-clear, inherit); }
.dot { width: 11px; height: 11px; border-radius: 50%; flex: 0 0 auto; box-sizing: border-box; border: 1px solid var(--c-font-dim, #787878); }
.dot.white { background: #f2f2f2; }
.dot.black { background: #222; }
.rep .tiles { display: flex; flex-wrap: wrap; gap: 5px; }
.rep .tile { padding: 3px 10px; border-radius: 6px; background: var(--c-bg-zebra, rgba(127,127,127,.1)); transition: background .12s, color .12s; }
.rep .tile:hover { background: var(--c-bg-zebra2, rgba(127,127,127,.2)); color: var(--c-font-clear, inherit); }
.rep .tile.main { font-weight: 700; color: var(--c-font-clear, inherit); }
.rep .mainline { display: flex; align-items: baseline; gap: 6px; width: 100%; margin-top: 6px; text-align: left;
  color: var(--c-font-dim, #787878); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.rep .mainline:hover { color: var(--c-primary, #1b78d0); }
.rep .mainline .ox-svg-icon { flex: 0 0 auto; align-self: center; }
.rep .banner { display: flex; gap: 8px; align-items: flex-start; padding: 7px 10px; border-radius: 8px;
  background: color-mix(in srgb, var(--c-bad, #c33) 16%, transparent); }
.rep .banner-icon { color: var(--c-bad, #c33); display: inline-flex; align-items: center; margin-top: 2px; }
.rep .lines { max-height: 220px; overflow-y: auto; scrollbar-width: thin; }
.rep .line-search-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.rep .line-search, .saveform input, .saveform select, .rep .linerow.editing input {
  box-sizing: border-box; min-width: 0; flex: 1; padding: 5px 8px; font: inherit; color: var(--c-font-clear, inherit);
  background: var(--c-bg-input, var(--c-bg-zebra, transparent)); border: 1px solid var(--c-border, #d9d9d9); border-radius: 6px; }
.rep .line-matches { white-space: nowrap; font-size: 12.5px; }
.rep .linerow { gap: 7px; min-height: 30px; }
.rep .linename { flex: 1 1 auto; min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.3; }
.rep .pill { flex: 0 0 auto; font-size: 11px; color: var(--c-font-dim, #787878); }
.rep .pill.main { font-weight: 700; color: var(--c-font, inherit); }
.rep .actions { display: flex; flex: 0 0 auto; opacity: .5; transition: opacity .12s; }
.rep .linerow:hover .actions, .rep .linerow:focus-within .actions { opacity: 1; }
.rep .icon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; color: var(--c-font-dim, #787878); }
.rep .icon svg { display: block; }
.rep .icon:hover { background: var(--c-bg-zebra2, rgba(127,127,127,.2)); color: var(--c-font-clear, inherit); }
.rep .icon.on { color: var(--c-primary, #1b78d0); }
.rep .icon.danger:hover { color: var(--c-bad, #c33); }
.rep .icon.good { color: var(--c-good, #629924); }
.rep .linerow.confirm .btn { padding: 4px 10px; }
.rep .footer .btns { margin-top: 12px; }
.rep .saveform { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--c-border, #d9d9d9); }
.rep .saveform .moves { font-size: 12.5px; font-variant-numeric: tabular-nums; }
.rep .saveform .btns { margin-top: 2px; }
.rep .seg { display: flex; border: 1px solid var(--c-border, #d9d9d9); border-radius: 6px; overflow: hidden; }
.rep .seg button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 5px; }
.rep .seg button.active { background: var(--c-bg-zebra2, rgba(127,127,127,.2)); color: var(--c-font-clear, inherit); font-weight: 600; }
`;
})();
