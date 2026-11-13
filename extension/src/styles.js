// Styles for the added boxes. They live inside each box's shadow root, so they
// cannot leak into Lichess and Lichess's CSS cannot break them. Colours come
// from Lichess's own theme variables, so light, dark and transparent themes
// all match.
(() => {
  const OX = (globalThis.OX = globalThis.OX || {});
  OX.css = `
:host { display: block; flex: 0 0 auto; }
.ox {
  font: inherit; font-size: 13px; line-height: 1.45;
  color: var(--c-font, #4d4d4d);
  background: var(--c-bg-box, #fff);
  border-top: 1px solid var(--c-border, #d9d9d9);
  padding: 6px 10px 7px;
}
.head { display: flex; align-items: center; gap: 8px; min-height: 22px; }
.title { font-weight: 600; white-space: nowrap; }
.title small { font-weight: normal; color: var(--c-font-dim, #787878); }
.grow { flex: 1 1 auto; min-width: 0; }
.dim { color: var(--c-font-dim, #787878); }
.eval { font-weight: 700; font-size: 1.25em; font-variant-numeric: tabular-nums; }
.pv { margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.pv b { font-weight: 600; }
button {
  font: inherit; color: inherit; background: none; border: 0; padding: 0 2px;
  cursor: pointer; border-radius: 3px;
}
button:hover { color: var(--c-primary, #1b78d0); }
.depth { color: var(--c-font-dim, #787878); font-size: 0.92em; white-space: nowrap; }
.switch { position: relative; width: 30px; height: 16px; flex: 0 0 auto; border-radius: 8px;
  background: var(--c-border, #d9d9d9); transition: background .15s; padding: 0; }
.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
  border-radius: 50%; background: var(--c-bg-box, #fff); transition: left .15s; }
.switch.on { background: var(--c-good, #629924); }
.switch.on::after { left: 16px; }
.chips { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-top: 3px; align-items: baseline; }
.chip { padding: 0 6px; border-radius: 3px; border: 1px solid var(--c-border, #d9d9d9); font-weight: 600; }
.chip.main { background: color-mix(in srgb, var(--c-good, #629924) 18%, transparent); border-color: var(--c-good, #629924); }
.chip.side { font-weight: normal; }
.left { color: var(--c-bad, #c33); }
.ok { color: var(--c-good, #629924); }
table { width: 100%; border-collapse: collapse; margin-top: 4px; font-variant-numeric: tabular-nums; }
th { text-align: left; font-weight: normal; color: var(--c-font-dim, #787878); font-size: .9em; padding: 2px 4px; }
td { padding: 3px 4px; border-top: 1px solid var(--c-border, #d9d9d9); white-space: nowrap; }
td.move { font-weight: 600; width: 3.5em; }
td.num { text-align: right; width: 3.5em; }
td.barcell { width: 100%; }
.bar { display: flex; height: 16px; border-radius: 3px; overflow: hidden; font-size: 11px; line-height: 16px; }
.bar span { text-align: center; overflow: hidden; color: #fff; }
.bar .w { background: var(--c-good, #629924); }
.bar .d { background: #8a8a8a; }
.bar .l { background: var(--c-bad, #c33); }
.tabs { display: flex; gap: 2px; }
.tabs button { padding: 1px 7px; border: 1px solid transparent; }
.tabs button.active { border-color: var(--c-border, #d9d9d9); background: var(--c-bg-zebra, rgba(127,127,127,.08)); font-weight: 600; }
textarea {
  display: block; box-sizing: border-box; width: 100%; min-height: 56px; margin-top: 4px; resize: vertical;
  font: inherit; color: inherit; background: var(--c-bg-zebra, transparent);
  border: 1px solid var(--c-border, #d9d9d9); border-radius: 3px; padding: 5px 7px;
}
textarea:focus { outline: 1px solid var(--c-primary, #1b78d0); }
.offline { color: var(--c-font-dim, #787878); font-style: italic; }
/* Boxes in Lichess's left column look like its other side boxes. */
.ox.card { border: 1px solid var(--c-border, #d9d9d9); border-radius: 6px; margin-top: 12px; padding: 8px 12px 10px; }
.ox.card .title { font-size: 1.05em; }
.row { margin-top: 6px; }
.line { cursor: pointer; }
.line:hover { color: var(--c-primary, #1b78d0); }
.btn { display: inline-block; margin-top: 8px; padding: 4px 10px; border-radius: 4px; font-weight: 600;
  border: 1px solid var(--c-border, #d9d9d9); background: var(--c-bg-zebra, rgba(127,127,127,.08)); }
.btn:hover { border-color: var(--c-primary, #1b78d0); color: var(--c-primary, #1b78d0); }
.btn.primary { background: var(--c-primary, #1b78d0); border-color: var(--c-primary, #1b78d0); color: #fff; }
.btns { display: flex; flex-wrap: wrap; gap: 6px; }
.mistakes { margin-top: 6px; }
.mistake { display: flex; gap: 8px; align-items: baseline; padding: 3px 4px; border-radius: 3px; cursor: pointer; }
.mistake:hover { background: var(--c-bg-zebra, rgba(127,127,127,.08)); }
.mistake .san { font-weight: 600; }
.bad { color: var(--c-bad, #c33); }
button.chip { cursor: pointer; }
/* ---- Repertoire box ---- */
[data-icon]::before { content: attr(data-icon); font-family: 'lichess'; font-style: normal; font-weight: normal; }
.rep .head { margin-bottom: 4px; }
.rep .title { font-size: 1.1em; letter-spacing: .01em; }
.rep .section { margin-top: 10px; }
.rep .section-head { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
.rep .section-title { font-weight: 600; }
.rep .dot { width: 11px; height: 11px; border-radius: 50%; flex: 0 0 auto; border: 1px solid var(--c-font-dim, #787878); }
.rep .dot.white { background: #f2f2f2; }
.rep .dot.black { background: #222; }
.rep .tiles { display: flex; flex-wrap: wrap; gap: 6px; }
.rep .tile { display: inline-flex; align-items: baseline; gap: 5px; padding: 5px 11px; border-radius: 5px; font-size: 1.08em; font-weight: 600;
  background: var(--c-bg-zebra, rgba(127,127,127,.1)); border: 1px solid var(--c-border, #d9d9d9); }
.rep .tile:hover { border-color: var(--c-primary, #1b78d0); color: inherit; }
.rep .tile.main { border-color: var(--c-good, #629924); background: color-mix(in srgb, var(--c-good, #629924) 20%, transparent); }
.rep .tile-tag { font-size: .68em; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--c-good, #629924); }
.rep .mainline { display: flex; align-items: baseline; gap: 6px; width: 100%; margin-top: 7px; padding: 4px 6px; text-align: left; border-radius: 4px;
  color: var(--c-font-dim, #787878); font-variant-numeric: tabular-nums; }
.rep .mainline:hover { background: var(--c-bg-zebra, rgba(127,127,127,.1)); color: var(--c-font, #4d4d4d); }
.rep .mainline .play { color: var(--c-good, #629924); font-size: .85em; }
.rep .banner { display: flex; gap: 8px; align-items: flex-start; margin-top: 6px; padding: 7px 9px; border-radius: 5px;
  background: color-mix(in srgb, var(--c-bad, #c33) 14%, transparent); border: 1px solid color-mix(in srgb, var(--c-bad, #c33) 45%, transparent); }
.rep .banner-icon { color: var(--c-bad, #c33); }
.rep .lines { display: flex; flex-direction: column; border: 1px solid var(--c-border, #d9d9d9); border-radius: 5px; overflow: hidden; }
.rep .linerow { display: flex; align-items: center; gap: 7px; padding: 5px 8px; min-height: 26px; }
.rep .linerow + .linerow { border-top: 1px solid var(--c-border, #d9d9d9); }
.rep .linerow:hover { background: var(--c-bg-zebra, rgba(127,127,127,.08)); }
.rep .linename { flex: 1 1 auto; min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.3; }
.rep .pill { flex: 0 0 auto; font-size: .72em; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: 9px;
  color: var(--c-font-dim, #787878); border: 1px solid var(--c-border, #d9d9d9); }
.rep .pill.main { color: var(--c-good, #629924); border-color: var(--c-good, #629924); }
.rep .actions { display: flex; gap: 2px; flex: 0 0 auto; opacity: .45; transition: opacity .12s; }
.rep .linerow:hover .actions { opacity: 1; }
.rep .icon { width: 24px; height: 24px; padding: 0; border-radius: 4px; color: var(--c-font-dim, #787878); }
.rep .icon:hover { background: var(--c-bg-zebra, rgba(127,127,127,.15)); color: var(--c-font, #4d4d4d); }
.rep .icon.on { color: var(--c-good, #629924); }
.rep .icon.danger:hover { color: var(--c-bad, #c33); }
.rep .icon.good { color: var(--c-good, #629924); }
.rep .linerow.editing input { flex: 1 1 auto; min-width: 0; font: inherit; color: inherit; background: var(--c-bg-zebra, transparent);
  border: 1px solid var(--c-primary, #1b78d0); border-radius: 3px; padding: 3px 6px; }
.rep .linerow.confirm { background: color-mix(in srgb, var(--c-bad, #c33) 10%, transparent); }
.rep .btn.danger { background: var(--c-bad, #c33); border-color: var(--c-bad, #c33); color: #fff; margin-top: 0; }
.rep .linerow.confirm .btn { margin-top: 0; }
.rep .more { margin-top: 5px; color: var(--c-primary, #1b78d0); }
.rep .footer { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--c-border, #d9d9d9); }
.rep .footer .btns { margin-top: 2px; }
.rep .btn-icon { margin-right: 6px; }
.rep .saveform { display: flex; flex-direction: column; gap: 7px; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--c-border, #d9d9d9); }
.rep .saveform .moves { font-variant-numeric: tabular-nums; }
.rep .seg { display: flex; border: 1px solid var(--c-border, #d9d9d9); border-radius: 5px; overflow: hidden; }
.rep .seg button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 5px; border-radius: 0; }
.rep .seg button.active { background: color-mix(in srgb, var(--c-primary, #1b78d0) 22%, transparent); font-weight: 600; }

.saveform input, .saveform select { box-sizing: border-box; width: 100%; font: inherit; color: inherit;
  background: var(--c-bg-zebra, transparent); border: 1px solid var(--c-border, #d9d9d9); border-radius: 3px; padding: 4px 6px; }
.saveform .btns { align-items: center; }
`;
})();
