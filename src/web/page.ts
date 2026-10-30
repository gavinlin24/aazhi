import type { BillRow, Participant } from "../db/bills";
import { formatAddons, formatCents, formatDate } from "../format";
import { debtorOf } from "../money/debtors";
import { itemPieces } from "../money/split";
import type { Addon, Cents, LineItem, ParticipantId, Share, SplitResult } from "../money/types";
import { CLIENT_SCRIPT } from "./client";
import { FONT_FACES } from "./fonts";
import { billState, type BillState, type StateParticipant, type StateExtras } from "./state";

export type { Editable } from "./state";

// Covers text and double-quoted attribute values alike; every attribute this
// file writes is double-quoted.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// JSON inside a script element is raw text to the HTML parser, so the only
// way out of it is a "<" starting "</script" or "<!--"; escaping every "<"
// closes both, and JSON.parse reads < back as "<".
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// Rice-paper grain: one small noise tile the browser rasterizes once. Two
// tints, so the specks read as fibre on light paper and on dark.
function grain(rgb: string, alpha: string): string {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'>" +
    "<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/>" +
    `<feColorMatrix values='0 0 0 0 ${rgb} 0 0 0 0 ${rgb} 0 0 0 0 ${rgb} 0 0 0 ${alpha} 0'/></filter>` +
    "<rect width='100%' height='100%' filter='url(%23g)'/></svg>";
  return `url("data:image/svg+xml,${svg.replace(/"/g, "'").replace(/</g, "%3C").replace(/>/g, "%3E")}")`;
}

// A mask that lets most of the seal through and drops it in fine flecks, the
// way a hand stamp never inks evenly.
function speckle(): string {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>" +
    "<filter id='s'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/>" +
    "<feColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -2.2 1.95'/></filter>" +
    "<rect width='100%' height='100%' filter='url(%23s)'/></svg>";
  return `url("data:image/svg+xml,${svg.replace(/</g, "%3C").replace(/>/g, "%3E")}")`;
}

// Ink & Paper. Every pair that carries meaning was checked against WCAG: 4.5:1
// for text, 3:1 for the tick rings and seals. The avatar hues are mineral
// pigments, each a wash with its own ink, so an initial always reads.
const STYLES = `${FONT_FACES}
:root {
  color-scheme: light dark;
  --paper: #f3eee3;
  --card: #faf7f0;
  --ink: #1d1b18;
  --muted: #5d564c;
  --ring: #8a8274;
  --line: #ddd3c1;
  --fill: #e9e1d1;
  --warn: #8a520f;
  --warn-soft: #f1e1c4;
  --ok: #2f6446;
  --ok-soft: #dce7d8;
  --seal: #b3302a;
  --seal-ink: #fbf3ea;
  --focus: #2d4b66;
  --rule: rgba(179, 48, 42, 0.22);
  --rule-strong: rgba(179, 48, 42, 0.62);
  --food: #5d564c;
  --tax: #a89c86;
  --tip: #d9cdb6;
  --scrim: rgba(29, 27, 24, 0.36);
  --grain: ${grain(".3", ".07")};
  --speckle: ${speckle()};
  --serif: "Iowan Old Style", "New York", ui-serif, "Noto Serif", "Source Serif Pro", Georgia, serif;
  --display: "Noto Serif Display", "Iowan Old Style", "New York", ui-serif, Georgia, serif;
  --brush: "Ma Shan Zheng", "Kaiti SC", "STKaiti", "KaiTi", "BiauKai", serif;
  --radius: 14px;
}
.hue-0 { --av-bg: #dce3ea; --av-ink: #2d4b66; }
.hue-1 { --av-bg: #f1e1c4; --av-ink: #74450c; }
.hue-2 { --av-bg: #dce7d8; --av-ink: #2f6446; }
.hue-3 { --av-bg: #f3dad3; --av-ink: #96291f; }
.hue-4 { --av-bg: #e8dce6; --av-ink: #683860; }
.hue-5 { --av-bg: #e6dccf; --av-ink: #5a4431; }
.hue-6 { --av-bg: #d6e6e4; --av-ink: #285a57; }
.hue-7 { --av-bg: #e2ded6; --av-ink: #45413a; }
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #15130f;
    --card: #1d1a16;
    --ink: #ece4d4;
    --muted: #a69d8d;
    --ring: #827968;
    --line: #3a342c;
    --fill: #2c2721;
    --warn: #dda458;
    --warn-soft: #3a2b16;
    --ok: #8fc7a2;
    --ok-soft: #1d3024;
    --seal: #c5463b;
    --seal-ink: #fffaf3;
    --focus: #93b4d3;
    --rule: rgba(197, 70, 59, 0.3);
    --rule-strong: rgba(197, 70, 59, 0.7);
    --food: #cfc5b3;
    --tax: #8a806f;
    --tip: #4f473c;
    --scrim: rgba(0, 0, 0, 0.55);
    --grain: ${grain(".9", ".05")};
  }
  .hue-0 { --av-bg: #23303c; --av-ink: #a9c2da; }
  .hue-1 { --av-bg: #3a2c17; --av-ink: #e2b57a; }
  .hue-2 { --av-bg: #1f3227; --av-ink: #9ccdae; }
  .hue-3 { --av-bg: #3d221f; --av-ink: #eba197; }
  .hue-4 { --av-bg: #33242f; --av-ink: #d5a9cb; }
  .hue-5 { --av-bg: #322a22; --av-ink: #d2b79c; }
  .hue-6 { --av-bg: #1c3231; --av-ink: #93c9c4; }
  .hue-7 { --av-bg: #2e2b26; --av-ink: #c9c1b3; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--paper) var(--grain);
  color: var(--ink);
  font: 16px/1.4 var(--serif);
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, p { margin: 0; }
button, input, select { font: inherit; color: inherit; }
button { -webkit-tap-highlight-color: transparent; }
a { color: inherit; }
:focus-visible { outline: 2.5px solid var(--focus); outline-offset: 2px; border-radius: 6px; }
.sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.sprite { position: absolute; width: 0; height: 0; overflow: hidden; }
.ic { width: 20px; height: 20px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
/* One look for "tap to change": the value sits in a tinted pill with a small
   brush inside, so the pill's edge, not a brush hanging past it, lines up
   with the plain values. Read-only values stay plain. The negative margin
   keeps a pill from making its line taller. */
.ic.brush { width: 16px; height: 16px; color: var(--muted); stroke-width: 1.6; }
.amt, .is-editable .item-price, button.payer-chip, .name-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  margin: -4px 0;
  padding: 0 9px 0 11px;
  border: 0;
  border-radius: 15px;
  background: var(--fill);
  color: var(--ink);
}
.amt:active, .is-editable button.row:active .item-price, .is-editable button.row:active .addon-amt, button.payer-chip:active, .name-btn:active { background: var(--line); }
@media (hover: hover) { .amt:hover, .is-editable button.row:hover .item-price, .is-editable button.row:hover .addon-amt, button.payer-chip:hover, .name-btn:hover { background: var(--line); } }
/* A 30px pill is easier to see than to hit, so the buttons reach 44px. */
.amt, button.payer-chip, .name-btn { position: relative; cursor: pointer; }
.amt::after, button.payer-chip::after, .name-btn::after { content: ""; position: absolute; inset: -7px -4px; }
.money, .item-price, .totals dd { font-variant-numeric: tabular-nums lining-nums; }
.page {
  max-width: 480px;
  margin: 0 auto;
  padding: 18px 16px calc(28px + env(safe-area-inset-bottom));
}
.page[data-layout="receipt"].has-bar { padding-bottom: calc(104px + env(safe-area-inset-bottom)); }
.page[data-layout="receipt"].has-bar:has(.claimers:not([hidden])) { padding-bottom: calc(156px + env(safe-area-inset-bottom)); }
/* Keyboard focus and claim mode scroll rows into view; keep them clear of the bar. */
html:has(.has-bar) { scroll-padding-bottom: calc(88px + env(safe-area-inset-bottom)); }
html:has(.has-bar .claimers:not([hidden])) { scroll-padding-bottom: calc(140px + env(safe-area-inset-bottom)); }
.needs-js { display: none; }
.is-live .needs-js:not([hidden]) { display: revert; }
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: 0 1px 2px rgba(60, 40, 10, 0.04);
}

.head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; align-items: start; padding: 0 2px 14px; }
.head h1 { font-size: 25px; line-height: 1.2; font-weight: 600; overflow-wrap: anywhere; }
.status { display: inline-flex; align-items: center; gap: 7px; height: 30px; font-size: 15px; color: var(--muted); white-space: nowrap; }
.seal-slot { width: 20px; height: 20px; border: 1.5px dashed var(--ring); border-radius: 3px; }
.seal {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 3px;
  background: var(--seal);
  color: var(--seal-ink);
  font: 19px/1 var(--brush);
  box-shadow: inset 0 0 0 1.5px var(--seal), inset 0 0 0 2.5px rgba(251, 243, 234, 0.7);
  transform: rotate(-6deg);
}
.live { width: 7px; height: 7px; border-radius: 50%; background: var(--ring); display: none; }
.is-live .live { display: inline-block; background: var(--ok); }
.is-live.is-stopped .live { background: var(--ring); }
.meta { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 16px; min-height: 30px; }
.payer-chip { display: inline-flex; align-items: center; gap: 5px; color: var(--ink); }
.payer-chip .ic { width: 17px; height: 17px; color: var(--warn); }
/* Undoes the coin's size and colour, which the chip's icon rule gives every icon in it. */
button.payer-chip .brush { width: 16px; height: 16px; color: var(--muted); }

.toast {
  position: fixed;
  z-index: 30;
  top: calc(10px + env(safe-area-inset-top));
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  max-width: min(448px, calc(100% - 32px));
  padding: 10px 16px;
  border-radius: 12px;
  background: var(--ink);
  color: var(--card);
  font-size: 15px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
}
.toast.is-warn { background: var(--warn-soft); color: var(--warn); border: 1px solid var(--warn); }

.notice-card { padding: 16px; margin-bottom: 14px; }
.notice-card h2 { font-size: 18px; }
.notice-card p { color: var(--muted); margin-top: 6px; }

.receipt { padding: 4px 0 6px; }
/* The scroll margin leaves room for the first line's focus ring when claim mode scrolls here. */
.items { list-style: none; margin: 0; padding: 0; scroll-margin-top: 16px; }
.item { position: relative; border-bottom: 1px solid var(--rule); }
/* The inset of the tick circles from the card. The figures, pills and rules
   end the same distance from the right, so the receipt is balanced. */
.receipt { --edge: 13px; }
.row {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  grid-template-rows: 23px 22px;
  grid-template-areas: "tick name price" "tick who piece";
  column-gap: 10px;
  align-items: center;
  width: 100%;
  margin: 0;
  padding: 8px var(--edge) 8px 4px;
  border: 0;
  background: none;
  text-align: left;
}
button.row { cursor: pointer; }
button.row:active { background: var(--fill); }
.row > .tick, .tick-btn { grid-area: tick; justify-self: center; }
/* Nobody else on the line means no avatars and no split, so the second line
   goes. Claiming it yourself keeps it bare, so your own tap never moves rows. */
.is-bare .row { grid-template-rows: 30px; grid-template-areas: "tick name price"; }
.is-bare .who, .is-bare .piece { display: none; }
.item-label { grid-area: name; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 17px; }
.item-price { grid-area: price; justify-self: end; white-space: nowrap; font-size: 17px; }
/* A dish's modifiers wrap rather than clip: they explain the price beside it. */
.item-addons { grid-area: addons; min-width: 0; font-size: 14px; line-height: 18px; color: var(--muted); padding-bottom: 2px; }
/* The dish's pill, scaled to the add-on line. The taller line keeps pills on
   wrapped lines from touching. */
.is-editable .item-addons { line-height: 26px; }
.addon-amt { white-space: nowrap; }
.is-editable .addon-amt { display: inline-flex; align-items: center; gap: 3px; height: 22px; padding: 0 6px 0 8px; border-radius: 11px; background: var(--fill); color: var(--ink); vertical-align: 1px; }
.addon-amt .ic.brush { width: 13px; height: 13px; }
.has-addons .row { grid-template-rows: 23px auto 22px; grid-template-areas: "tick name price" "tick addons addons" "tick who piece"; }
.is-bare.has-addons .row { grid-template-rows: 30px auto; grid-template-areas: "tick name price" "tick addons addons"; }
.who { grid-area: who; display: flex; align-items: center; min-width: 0; }
.piece { grid-area: piece; justify-self: end; white-space: nowrap; font-size: 15px; color: var(--muted); }
.piece .money { color: var(--ink); margin-left: 4px; }
.tick-btn {
  position: absolute;
  z-index: 1;
  left: 4px;
  top: 0;
  bottom: 0;
  width: 44px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
}
.tick {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1.6px solid var(--ring);
  color: var(--card);
}
.tick .ic { width: 16px; height: 16px; stroke-width: 2.2; opacity: 0; }
.is-mine .tick { background: var(--ink); border-color: var(--ink); }
.is-mine .tick .ic { opacity: 1; }
/* Claiming for a guest, the ticks become their face, so a glance down the
   column says whose lines these are. An empty ring holds their initial in
   pencil: a tap there goes to them. Their own pigment only once it is theirs,
   since some pigments are the warning red. */
.tick.is-other { color: var(--ring); font-size: 13px; font-weight: 600; line-height: 1; }
.is-mine .tick.is-other { background: var(--av-bg); border: 1.6px dashed var(--av-ink); color: var(--av-ink); }
.is-unclaimed .tick { border: 1.6px dashed var(--warn); }
.is-unclaimed .item-label { color: var(--warn); }
/* Nothing on a locked line answers a tap, so it draws no ring to tap: a bare
   check on your lines, the small unclaimed ring from the totals on nobody's. */
.is-locked .tick { border-color: transparent; }
.is-locked.is-mine .tick { background: none; border-color: transparent; color: var(--ink); }
.is-locked.is-mine .tick .ic { width: 20px; height: 20px; }
.is-locked.is-unclaimed .tick { width: 18px; height: 18px; border: 1.6px dashed var(--warn); }
.is-inked .tick { animation: ink 320ms ease-out; }
@keyframes ink {
  from { transform: scale(0.55); filter: blur(1.5px); }
  to { transform: scale(1); filter: blur(0); }
}

.av {
  --s: 22px;
  display: inline-grid;
  place-items: center;
  flex: none;
  width: var(--s);
  height: var(--s);
  border-radius: 50%;
  background: var(--av-bg, var(--fill));
  color: var(--av-ink, var(--ink));
  font-size: calc(var(--s) * 0.5);
  font-weight: 600;
  line-height: 1;
  box-shadow: 0 0 0 1.5px var(--card);
}
.stack { display: inline-flex; align-items: center; }
.stack > .av + .av { margin-left: -5px; }
.more { background: var(--fill); color: var(--muted); font-size: calc(var(--s) * 0.45); }
.av.is-viewer { box-shadow: 0 0 0 1.5px var(--card), 0 0 0 3px var(--ink); }
.av.is-guest { border: 1px dashed var(--av-ink); }

/* Spans from the ticks to the brushes, the full width a line can take. */
.add-line { padding: 8px var(--edge) 4px; }
.add-row {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 44px;
  border: 1.5px dashed var(--ring);
  border-radius: 10px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.add-row .ic { width: 22px; height: 22px; }

.totals { margin: 8px 0 0; padding: 0 var(--edge) 10px; }
.trow { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; }
.trow dt { display: flex; align-items: baseline; gap: 8px; color: var(--muted); min-width: 0; }
.trow dd { margin: 0; white-space: nowrap; }
/* Subtotal plus tax, so it sits under them as their sum. */
.receipt-row { margin-top: 4px; border-top: 1px solid var(--rule); }
.receipt-row dt { align-items: center; }
.receipt-row .mark { display: inline-flex; align-items: center; gap: 4px; font-size: 14px; }
.receipt-row.is-ok .mark { color: var(--ok); }
.receipt-row.is-off .mark { color: var(--warn); font-weight: 600; }
.receipt-row .mark .ic { width: 18px; height: 18px; }
/* A ledger's total: one rule above, a double rule below. */
.grand {
  margin: 6px 0 2px;
  padding: 4px 0;
  border-top: 1px solid var(--rule-strong);
  border-bottom: 3px double var(--rule-strong);
  font-size: 19px;
  font-weight: 600;
}
.grand dt { color: var(--ink); }
.short dt, .short dd { color: var(--warn); font-weight: 600; }
.dash-ring { width: 18px; height: 18px; border-radius: 50%; border: 1.6px dashed currentColor; flex: none; }
.short dt { align-items: center; }

.edit-form { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; width: 100%; padding: 4px 0; }
.edit-form .money-input { min-width: 88px; }
.edit-form label { color: var(--muted); flex: none; }
.money-input {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 44px;
  padding: 0 10px;
  border: 1.5px solid var(--line);
  border-radius: 10px;
  background: var(--paper);
}
.money-input:focus-within { border-color: var(--focus); }
.money-input span { color: var(--muted); }
.money-input.is-percent span { order: 2; }
.money-input input, .text-input {
  flex: 1;
  min-width: 0;
  height: 40px;
  border: 0;
  background: transparent;
  font-size: 17px;
  font-variant-numeric: tabular-nums;
  outline: none;
}
.text-input { height: 44px; padding: 0 10px; border: 1.5px solid var(--line); border-radius: 10px; background: var(--paper); }
.text-input:focus { border-color: var(--focus); }
.icon-btn {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1.5px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  cursor: pointer;
}
.icon-btn.go { background: var(--ink); border-color: var(--ink); color: var(--card); }
.icon-btn.danger { color: var(--seal); }
.icon-btn.danger.is-armed { background: var(--seal); border-color: var(--seal); color: var(--seal-ink); }
.icon-btn:disabled { opacity: 0.4; cursor: default; }
.seg { display: inline-flex; flex: none; height: 44px; padding: 3px; border: 1.5px solid var(--line); border-radius: 10px; }
.seg button { min-width: 34px; border: 0; border-radius: 7px; background: none; color: var(--muted); font-weight: 600; cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--ink); color: var(--card); }
.field-msg { flex-basis: 100%; color: var(--warn); font-size: 15px; }
.field-msg:empty { display: none; }
.field-msg.is-hint { color: var(--muted); }
.trow.is-editing { flex-wrap: wrap; }

/* Its fields keep the width of the box it opens from. */
.line-form { display: grid; grid-template-columns: minmax(0, 1fr) 112px; gap: 8px; padding: 2px 0 8px; }
.line-form .actions { grid-column: 1 / -1; display: flex; gap: 8px; }
.line-form .actions .go { margin-left: auto; }
.line-form .field-msg { grid-column: 1 / -1; }
/* Editing a dish lays it out like the receipt: its own price, then one row
   per add-on, every price in one column so the sum reads down. */
.dish-form { grid-template-columns: minmax(0, 1fr) 112px 44px; }
.dish-form > [name="label"] { grid-column: 1 / -1; }
.dish-form .money-input { grid-column: 2; }
.dish-form .field-label { grid-column: 1; align-self: center; color: var(--muted); }
.dish-form .addons-head { grid-column: 1 / -1; margin-top: 6px; color: var(--muted); font-size: 15px; }
.addon { display: contents; }
.addon .text-input { grid-column: 1; }
.addon .icon-btn { border-color: transparent; background: none; color: var(--muted); }
.dish-form .add-row { grid-column: 1 / 3; gap: 6px; font-size: 16px; }
.dish-form [hidden] { display: none; }

.people { list-style: none; margin: 14px 0 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px 4px; }
.tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  width: 100%;
  min-height: 98px;
  padding: 8px 2px 6px;
  border: 0;
  border-radius: 12px;
  background: none;
  text-align: center;
}
button.tile { cursor: pointer; }
button.tile:active { background: var(--fill); }
.avw { position: relative; display: inline-block; margin-bottom: 3px; }
.tile .av { --s: 46px; }
.tile-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
.tile.is-viewer .tile-name { font-weight: 700; }
.tile-amt { font-size: 15px; color: var(--muted); }
.tile-amt.is-forgiven, .was { text-decoration: line-through; }
.badge {
  position: absolute;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--card);
  box-shadow: 0 0 0 1px var(--line);
}
.badge .ic { width: 15px; height: 15px; }
.badge.coin { top: -3px; right: -5px; color: var(--warn); }
.badge.gift { top: -3px; left: -5px; color: var(--seal); }
.minis { position: absolute; right: -8px; bottom: -4px; display: flex; }
.minis .av { --s: 22px; }
.minis .av + .av { margin-left: -8px; }
.stamp {
  display: inline-grid;
  place-items: center;
  padding: 2px;
  border: 1.5px solid var(--seal);
  border-radius: 3px;
  color: var(--seal);
  font: 13px/1 var(--brush);
  writing-mode: vertical-rl;
  letter-spacing: 1px;
  transform: rotate(-8deg);
  background: color-mix(in srgb, var(--card) 70%, transparent);
}
.avw > .stamp { position: absolute; left: -10px; bottom: -6px; }
.is-pressed { animation: press 300ms cubic-bezier(.3, 1.4, .5, 1); }
@keyframes press {
  from { transform: scale(1.6) rotate(-14deg); opacity: 0; }
  to { transform: scale(1) rotate(-6deg); opacity: 1; }
}
/* The small stamp waits for the big one to lift, so the seal reads as one
   mark that came down and stayed. */
.is-pressed.is-after-slam { animation-delay: 820ms; animation-fill-mode: backwards; }
/* Paying in full: the seal comes down on the page like a stamp on paper. It
   drops in large and tilted, presses past its size and springs back, bleeds a
   ring of ink, holds a beat, and lifts, all in a second. */
.slam {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding-bottom: 12vh;
  pointer-events: none;
  animation: slam-wash 1000ms ease both;
}
.slam .stamp {
  position: relative;
  padding: 14px 10px;
  border-width: 6px;
  border-radius: 9px;
  font-size: 84px;
  letter-spacing: 10px;
  background: none;
  -webkit-mask: var(--speckle);
  mask: var(--speckle);
  animation: slam 1000ms both;
}
.slam .stamp::after {
  content: "";
  position: absolute;
  inset: -6px;
  border: 3px solid var(--seal);
  border-radius: 12px;
  opacity: 0;
  animation: bleed 1000ms ease-out both;
}
@keyframes slam {
  0% { transform: scale(2.6) rotate(-24deg); opacity: 0; animation-timing-function: cubic-bezier(.55, 0, 1, .45); }
  17% { transform: scale(.93) rotate(-8deg); opacity: 1; animation-timing-function: ease-out; }
  25% { transform: scale(1.03) rotate(-8deg); }
  33% { transform: scale(1) rotate(-8deg); }
  80% { transform: scale(1) rotate(-8deg); opacity: 1; }
  100% { transform: scale(1) rotate(-8deg); opacity: 0; }
}
@keyframes bleed {
  0%, 16% { opacity: 0; transform: scale(.97); }
  19% { opacity: .5; }
  50%, 100% { opacity: 0; transform: scale(1.22); }
}
@keyframes slam-wash {
  0% { background: transparent; }
  14%, 80% { background: color-mix(in srgb, var(--paper) 55%, transparent); }
  100% { background: transparent; }
}
@keyframes slam-fade {
  0%, 100% { opacity: 0; transform: rotate(-8deg); }
  20%, 80% { opacity: 1; transform: rotate(-8deg); }
}
.add-tile .av { background: none; border: 1.5px dashed var(--ring); color: var(--muted); box-shadow: none; }
.add-tile .av .ic { width: 22px; height: 22px; }
.add-tile .tile-name { color: var(--muted); }
.guest-form-slot { grid-column: 1 / -1; }
.guest-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 0 4px; }
.guest-form .text-input { flex: 1; min-width: 0; }
.guest-form > .av { --s: 36px; }

.bar {
  position: fixed;
  z-index: 10;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
  background: var(--card);
  border-top: 1px solid var(--line);
  box-shadow: 0 -6px 20px rgba(60, 40, 10, 0.06);
}
/* Bottom-aligned so the arrow and face sit on the amount's line, under its
   caption, not centred on the two together. Its width and gutters match the
   page's, so the caption, amount and claim chips start on the card's edge. */
.bar-in { display: flex; align-items: flex-end; gap: 10px; max-width: 448px; min-height: 52px; margin: 0 auto; }
/* Who a tap on a line claims for, one tap to switch. It shows only when there
   is more than one answer: you and the guests you brought. */
/* The padding gives a focused chip's ring room inside the scroller, which
   would clip it; the negative margin takes the room back. */
.claimers {
  display: flex;
  gap: 6px;
  max-width: 458px;
  margin: -5px max(-5px, calc((100% - 448px) / 2 - 5px)) 3px;
  padding: 5px;
  overflow-x: auto;
  scrollbar-width: none;
}
.claimers[hidden] { display: none; }
.claimer {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: none;
  max-width: 14em;
  height: 44px;
  padding: 0 14px 0 6px;
  border: 1.5px solid var(--line);
  border-radius: 22px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.claimer .av { --s: 30px; box-shadow: none; }
.claimer .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.claimer .chip-amt { flex: none; font-weight: 400; }
.claimer[aria-pressed="true"] { background: var(--ink); border-color: var(--ink); color: var(--card); font-weight: 600; }
.claimer[aria-pressed="true"] .av { box-shadow: 0 0 0 1.5px var(--card); }
.bar .av.payer { --s: 32px; margin-bottom: -2px; }
.bar .arrow { width: 22px; height: 22px; color: var(--muted); margin-bottom: 3px; }
/* Reads as a sentence, the same way for whoever is looking: what moves, which
   way, to whom. The caption says which side of it you are on. */
.bar .owe { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.bar .owe-label { font-size: 14px; line-height: 1; color: var(--muted); }
.bar .amount { font: 500 28px/1 var(--display); letter-spacing: -0.01em; white-space: nowrap; }
.bar .grow { flex: 1; }
/* The same dashed ring as an unclaimed line, with the count spelled out. */
.ring-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 44px;
  padding: 0 14px 0 11px;
  border: 0;
  border-radius: 22px;
  background: var(--warn-soft);
  color: var(--warn);
  font-weight: 700;
  font-size: 16px;
  white-space: nowrap;
  align-self: center;
  cursor: pointer;
}

.view + .view { margin-top: 18px; }
.is-live[data-layout="share"] .view:not(.is-active) { display: none; }
.is-live[data-layout="share"] .view + .view { margin-top: 0; }
.hero { position: relative; padding: 18px 18px 16px; overflow: hidden; }
.flow { display: flex; align-items: center; gap: 8px; }
.flow .av { --s: 34px; }
.flow .stack .av + .av { margin-left: -6px; }
.flow .arrow { width: 26px; height: 26px; color: var(--muted); }
.hero-amt { font: 500 50px/1.1 var(--display); letter-spacing: -0.02em; margin-top: 12px; }
/* Same words and weight as the bar's label, so the two read as one sentence. */
.hero-cap { margin-top: 14px; font-size: 14px; line-height: 1; color: var(--muted); }
.hero-cap + .collect .hero-amt { margin-top: 2px; }
.hero .was { color: var(--muted); font-size: 18px; margin-top: 12px; }
.hero .was + .hero-amt { margin-top: 0; }
.hero .stamp { position: absolute; right: 20px; top: 54px; font-size: 26px; padding: 5px 4px; border-width: 2.5px; letter-spacing: 3px; }
.hero .gift-mark { position: absolute; right: 22px; top: 62px; color: var(--seal); }
.hero .gift-mark .ic { width: 34px; height: 34px; }
.split-bar { display: flex; gap: 2px; height: 8px; margin-top: 14px; border-radius: 4px; overflow: hidden; }
.split-bar span { min-width: 3px; }
.split-bar .food, .key.food { background: var(--food); }
.split-bar .tax, .key.tax { background: var(--tax); }
.split-bar .tip, .key.tip { background: var(--tip); }
.legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 8px; color: var(--muted); font-size: 15px; }
.legend > span { display: inline-flex; align-items: center; gap: 5px; }
.legend .key { width: 9px; height: 9px; border-radius: 2px; }
.legend .ic { width: 18px; height: 18px; }
.pay-row { display: flex; gap: 8px; margin-top: 16px; }
/* Basis 0 splits the row equally among however many apps the payer has. */
.pay {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 0;
  min-height: 46px;
  padding: 0 12px;
  border-radius: 23px;
  background: var(--seal);
  color: var(--seal-ink);
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
.pay .ic { width: 18px; height: 18px; }
/* Whose shares one amount covers, when it covers guests too. */
.whose { list-style: none; margin: 12px 0 0; padding: 0; }
.whose li { display: flex; align-items: center; gap: 10px; min-height: 40px; border-top: 1px solid var(--rule); }
.whose .av { --s: 28px; }
.whose .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.whose .note { flex: 1; color: var(--muted); font-size: 15px; white-space: nowrap; }
.whose .is-off { color: var(--muted); }
.hero .whose .stamp { position: static; font-size: 12px; padding: 2px 1px; border-width: 1.5px; letter-spacing: 1px; }
/* Recording a payment is the person's own word, not a link out, so it is
   inked rather than sealed and sits under the ways to pay. */
.sent-row { margin-top: 16px; }
.pay-row + .sent-row { margin-top: 10px; }
.sent {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  min-height: 46px;
  padding: 0 18px;
  border: 1.5px solid var(--ink);
  border-radius: 23px;
  background: var(--ink);
  color: var(--card);
  font-weight: 600;
  cursor: pointer;
}
.sent .ic { width: 18px; height: 18px; stroke-width: 2.2; }
.sent[aria-busy="true"] { cursor: progress; opacity: 0.6; }
.collect { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pie { width: 54px; height: 54px; margin-top: 12px; transform: rotate(-90deg); }
.pie circle { fill: none; stroke-width: 6; }
.pie .track { stroke: var(--fill); }
.pie .done { stroke: var(--ok); stroke-linecap: round; }

.mine { margin-top: 12px; padding: 4px 16px; }
.mine ul { list-style: none; margin: 0; padding: 0; }
.mine li { display: flex; align-items: center; gap: 10px; min-height: 44px; border-bottom: 1px solid var(--rule); }
.mine li:last-child { border-bottom: 0; }
.mine li .item-label { flex: 1; }
.mine .piece { color: var(--muted); }
.mine .tax-tip, .sheet-lines .tax-tip { color: var(--muted); }
/* A guest's lines hang off their name under a dashed rule, the same dash as a
   guest's avatar, so it is plain which lines are theirs. */
.mine-group { border-top: 1px solid var(--rule); }
.mine > .mine-group:first-child { border-top: 0; }
.mine-guest { display: flex; align-items: center; gap: 8px; padding: 12px 0 2px; color: var(--muted); font-size: 15px; }
.mine-guest .av { --s: 24px; }
.mine-group ul { margin: 0 0 8px 11px; padding-left: 21px; border-left: 1.5px dashed var(--ring); }

.drill { margin-top: 12px; padding: 0 6px; }
.drill-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 56px;
  padding: 0 10px;
  text-decoration: none;
  border-bottom: 1px solid var(--rule);
}
.drill-row:last-child { border-bottom: 0; }
.drill-row .grow { flex: 1; }
.drill-row .ic { color: var(--muted); }
.drill-row .stack .av { --s: 26px; }
.drill-row .count { color: var(--muted); font-size: 15px; }
/* What can be done to the bill as a whole. Plain rows like the drill card's,
   so they read as quieter than paying, with Confirm the one loud thing. */
.acts { margin-top: 14px; padding: 0 6px; }
.view .acts { margin-top: 12px; }
.confirm-area { padding: 14px 10px; border-bottom: 1px solid var(--rule); }
.confirm-area:last-child { border-bottom: 0; }
.confirm-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  min-height: 52px;
  padding: 0 20px;
  border: 0;
  border-radius: 26px;
  background: var(--seal);
  color: var(--seal-ink);
  font-size: 18px;
  font-weight: 600;
  cursor: pointer;
}
.confirm-btn .brush { font: 23px/1 var(--brush); }
.confirm-btn:disabled { background: var(--fill); color: var(--muted); cursor: default; }
.confirm-btn[aria-busy="true"] { cursor: progress; opacity: 0.75; }
.why { margin-top: 10px; text-align: center; color: var(--warn); font-size: 15px; font-weight: 600; }
.why.is-hint { color: var(--muted); font-weight: 400; }
.act {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 56px;
  padding: 8px 10px;
  border: 0;
  border-bottom: 1px solid var(--rule);
  background: none;
  text-align: left;
  cursor: pointer;
}
.act:last-child { border-bottom: 0; }
.act:active { background: var(--fill); }
.act .ic { color: var(--muted); }
.act .grow { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.act-sub { color: var(--muted); font-size: 15px; }
.act.is-warn .ic { color: var(--warn); }
.act.danger, .act.danger .ic { color: var(--seal); }
.act[aria-busy="true"] { cursor: progress; opacity: 0.6; }

.payments { margin-top: 12px; padding: 0 16px 4px; }
.payments h2 { padding: 14px 0 2px; color: var(--muted); font-size: 15px; font-weight: 600; }
.payments ul { list-style: none; margin: 0; padding: 0; }
.payments li { display: flex; align-items: center; gap: 10px; min-height: 56px; border-bottom: 1px solid var(--rule); }
.payments li:last-child { border-bottom: 0; }
.payments .av { --s: 30px; }
.payments .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.payments .stamp { margin-right: 4px; }
.payments .chip-btn { padding: 0 14px; font-size: 15px; }

.back { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; margin: -6px 0 6px -8px; padding: 0 8px; color: var(--muted); text-decoration: none; }

dialog.sheet {
  position: fixed;
  inset: auto 0 0;
  width: 100%;
  max-width: 480px;
  max-height: 86vh;
  margin: 0 auto;
  padding: 0 0 env(safe-area-inset-bottom);
  border: 0;
  border-radius: 18px 18px 0 0;
  background: var(--card) var(--grain);
  color: var(--ink);
  box-shadow: 0 -8px 36px rgba(0, 0, 0, 0.2);
}
dialog.sheet::backdrop { background: var(--scrim); }
.sheet-in { padding: 6px 18px 20px; }
.sheet-head { display: flex; align-items: center; gap: 12px; min-height: 60px; }
.sheet-head .av { --s: 44px; }
.sheet-head h2 { flex: 1; min-width: 0; font-size: 20px; font-weight: 600; overflow-wrap: anywhere; }
.sheet-head .money { font: 500 24px/1 var(--display); }
.sheet .close { border: 0; background: none; margin-right: -4px; }
.sheet .legend { margin: 0 0 6px; }
/* No bar in the sheet for a key to point at. */
.sheet .legend .key { display: none; }
.sheet ul { list-style: none; margin: 0; padding: 0; }
.sheet-lines li { display: flex; align-items: center; gap: 10px; min-height: 42px; border-bottom: 1px solid var(--rule); }
.sheet-lines li:last-child { border-bottom: 0; }
.sheet-lines .item-label { flex: 1; font-size: 16px; }
.sheet-lines .empty { color: var(--muted); }
.sheet-guest { margin-top: 14px; padding-top: 10px; border-top: 3px double var(--rule); }
.sheet-guest .sheet-head .av { --s: 34px; }
.sheet-guest h3 { flex: 1; min-width: 0; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
/* A long name wraps inside its pill instead of overflowing the sheet. */
.name-btn { height: auto; min-height: 30px; max-width: 100%; padding-block: 4px; font: inherit; text-align: left; }
.name-btn > span { overflow-wrap: anywhere; }
.sheet-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.chip-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 0 16px;
  border: 1.5px solid var(--line);
  border-radius: 22px;
  background: var(--card);
  font-weight: 600;
  cursor: pointer;
}
.chip-btn .ic { width: 18px; height: 18px; }
.chip-btn[aria-pressed="true"] { background: var(--ink); border-color: var(--ink); color: var(--card); }
.chip-btn.danger { color: var(--seal); }
.chip-btn.danger.is-armed { background: var(--seal); border-color: var(--seal); color: var(--seal-ink); }
.chip-btn:disabled { opacity: 0.45; cursor: default; }
.chip-btn[aria-busy="true"] { cursor: progress; }
.sheet-body { margin: 0 0 10px; color: var(--muted); }
.sheet-go { flex: 1; justify-content: center; min-height: 50px; border-radius: 25px; }
.sheet-go.is-seal { background: var(--seal); border-color: var(--seal); color: var(--seal-ink); }
.sheet-go.is-ink { background: var(--ink); border-color: var(--ink); color: var(--card); }
.sheet-msg { margin-top: 8px; color: var(--warn); font-size: 15px; }
.sheet-msg:empty { display: none; }
.picker { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; margin: 4px 0 8px; }
.pick { position: relative; }
.pick .tick { position: absolute; right: -6px; bottom: -4px; width: 22px; height: 22px; background: var(--card); }
.pick .tick .ic { width: 14px; height: 14px; }
.pick[aria-pressed="true"] .tick { background: var(--ink); border-color: var(--ink); }
.pick[aria-pressed="true"] .tick .ic { opacity: 1; }
.pick .tile-name { font-size: 14px; }
.sheet .line-form { padding: 6px 0 4px; }

.notice { margin-top: 18vh; padding: 22px 20px; text-align: center; }
.notice h1 { font-size: 23px; line-height: 1.25; }
.notice p { color: var(--muted); margin-top: 10px; }

@media (prefers-reduced-motion: reduce) {
  .is-inked .tick, .is-pressed { animation: none; }
  .slam .stamp { animation-name: slam-fade; }
  .slam .stamp::after { animation: none; }
}
@media (min-width: 700px) {
  .page { padding-top: 40px; }
}
`;

// One brush-weight stroke set, referenced by <use> from the page and the
// script alike, so neither repeats path data.
const ICONS: Record<string, string> = {
  check: '<path d="M5 12.5l4.3 4.3L19 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M4 12h15M14 6.5l5.5 5.5-5.5 5.5"/>',
  out: '<path d="M7 17L17 7M9 7h8v8"/>',
  chev: '<path d="M9.5 6l6 6-6 6"/>',
  back: '<path d="M14.5 6l-6 6 6 6"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6h4.8v4.8H9.6z"/>',
  gift: '<path d="M4.5 11h15v9h-15zM3.5 7.5h17V11h-17zM12 7.5V20M12 7.5C10.5 4 7 4 7.5 6.3 8 7.5 12 7.5 12 7.5zM12 7.5c1.5-3.5 5-3.5 4.5-1.2C16 7.5 12 7.5 12 7.5z"/>',
  receipt: '<path d="M6 3.5h12v17l-2.5-1.6-2.5 1.6-2.5-1.6-2.5 1.6-2.5-1.6zM9 8.5h6M9 12h6M9 15.5h3"/>',
  people: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5"/><circle cx="16.5" cy="9.5" r="2.6"/><path d="M15.5 14.2c2.6-.3 4.4 1.3 5 4.3"/>',
  bowl: '<path d="M3.5 11.5h17a8.5 8.5 0 0 1-17 0zM9 8c-.8-1.4.8-2.2 0-3.8M13 8c-.8-1.4.8-2.2 0-3.8"/>',
  trash: '<path d="M5 7h14M9.5 7V4.5h5V7M7 7l1 13h8l1-13M10.5 11v5.5M13.5 11v5.5"/>',
  warn: '<path d="M12 4.5l8.5 15h-17zM12 10.5v4M12 17.3v.2"/>',
  // A calligraphy brush: handle, ferrule, and an inked tip that tapers to a point.
  brush: '<path d="M19.6 4.4l-6.2 6.2M10.9 10.3l2.8 2.8"/><path fill="currentColor" stroke="none" d="M10 10.8c-2.2.3-4.5 4.6-5.6 8.8 4.2-1.1 8.5-3.4 8.8-5.6z"/>',
};

function sprite(): string {
  const symbols = Object.entries(ICONS)
    .map(([name, paths]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${paths}</symbol>`)
    .join("");
  return `<svg class="sprite" aria-hidden="true" focusable="false">${symbols}</svg>`;
}

function icon(name: string, extra = ""): string {
  return `<svg class="ic${extra ? ` ${extra}` : ""}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
}

const BRUSH = icon("brush", "brush");

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f3eee3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#15130f" media="(prefers-color-scheme: dark)">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// Notices carry only fixed text, never anything from a bill, so a refused
// visitor learns nothing about what the link pointed at.
function notice(heading: string, paragraph: string): string {
  return shell(
    `${heading} · AAzhi`,
    `<main class="page"><div class="card notice"><h1>${heading}</h1><p>${paragraph}</p></div></main>`,
  );
}

export function renderLinkRefused(): string {
  return notice(
    "This link has expired",
    "Split links last 30 minutes and only work for the person who tapped. " +
      "Go back to the bill in Discord and tap <strong>Open the split</strong> for a fresh one.",
  );
}

export function renderBillNotFound(): string {
  return notice(
    "There's no split here",
    "This bill doesn't exist any more. Go back to Discord and tap <strong>Open the split</strong> on the latest bill message.",
  );
}

export function renderBillGone(status: "superseded" | "deleted"): string {
  return status === "superseded"
    ? notice(
        "This split was replaced",
        "A newer split was started in the same channel. Open the newer bill message in Discord and tap " +
          "<strong>Open the split</strong> there.",
      )
    : notice("This split was deleted", "The person who paid deleted this bill, so there's nothing left to claim on it.");
}

interface View {
  bill: BillRow;
  s: BillState;
  people: Map<ParticipantId, StateParticipant>;
  shares: Map<ParticipantId, Share>;
  onBill: boolean;
  year: number;
}

// The script in client.ts draws the same markup from the same state on
// every poll; a change to any of it here needs the matching change there.
const STATUS_WORD: Record<BillRow["status"], string> = {
  reading: "Reading",
  draft: "Draft",
  confirmed: "Confirmed",
  superseded: "Replaced",
  deleted: "Deleted",
};

// A draft is for claiming, so the receipt is the page. Once confirmed the
// only thing left to do is read your amount and pay it, so that comes first.
function layoutOf(status: BillRow["status"]): "receipt" | "share" {
  return status === "confirmed" ? "share" : "receipt";
}

// Stable per person, not per name, so a renamed guest keeps their colour.
function hueOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.codePointAt(0)!) % 1_000_003;
  return h % 8;
}

function initialOf(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toUpperCase();
}

function nameOf(v: View, id: ParticipantId): string {
  return v.people.get(id)?.displayName ?? id;
}

function av(v: View, id: ParticipantId, extra = ""): string {
  const p = v.people.get(id);
  const classes = [`av hue-${hueOf(id)}`, id === v.s.viewer ? "is-viewer" : "", p?.kind === "guest" ? "is-guest" : "", extra];
  return `<span class="${classes.filter(Boolean).join(" ")}" aria-hidden="true">${escapeHtml(initialOf(nameOf(v, id)))}</span>`;
}

function stack(v: View, ids: ParticipantId[], max: number): string {
  if (ids.length === 0) return "";
  const shown = ids.length > max ? ids.slice(0, max - 1) : ids;
  const rest = ids.length - shown.length;
  const label = escapeHtml(ids.map((id) => nameOf(v, id)).join(", "));
  return (
    `<span class="stack" role="img" aria-label="${label}">${shown.map((id) => av(v, id)).join("")}` +
    `${rest > 0 ? `<span class="av more" aria-hidden="true">+${rest}</span>` : ""}</span>`
  );
}

function guestsOf(v: View, id: ParticipantId): StateParticipant[] {
  return v.s.participants.filter((p) => p.kind === "guest" && p.addedBy === id);
}

// Roster order, viewer first: the face someone looks for is always first.
function membersFirst(v: View): StateParticipant[] {
  const members = v.s.participants.filter((p) => p.kind === "member");
  return [...members.filter((p) => p.id === v.s.viewer), ...members.filter((p) => p.id !== v.s.viewer)];
}

function owedOf(v: View, id: ParticipantId): Cents {
  return v.s.owing[id]?.owedCents ?? 0;
}

function leftOf(v: View, id: ParticipantId): Cents {
  const o = v.s.owing[id];
  return o ? Math.max(0, o.owedCents - o.paidCents) : 0;
}

// Paid up means a payment covered it, not merely nothing asked: a forgiven
// share gets the gift, not the stamp.
function paidUp(v: View, id: ParticipantId): boolean {
  const o = v.s.owing[id];
  return v.bill.status === "confirmed" && id !== v.bill.payerId && !!o && o.owedCents > 0 && o.paidCents >= o.owedCents;
}

// A member who paid in full paid their guests' shares with it, so those
// guests are paid too, until that is undone. A forgiven guest keeps the gift.
// Paying the adder settles nothing with the payer, so only the adder sees
// that one as paid.
function guestPaid(v: View, g: StateParticipant): boolean {
  if (g.paidToPayer === true || (g.paidToHost === true && g.addedBy === v.s.viewer)) return true;
  const debtor = debtorOf(g, v.bill.payerId);
  return debtor !== g.id && paidUp(v, debtor) && v.shares.get(g.id)?.pardoned !== true;
}

function forgivenWhole(v: View, id: ParticipantId): boolean {
  const shares = [id, ...guestsOf(v, id).map((g) => g.id)].map((x) => v.shares.get(x)).filter((x): x is Share => !!x);
  return shares.length > 0 && shares.every((x) => x.pardoned);
}

function shortDate(iso: string | null, year: number): string | null {
  const full = formatDate(iso);
  return full && full.endsWith(`, ${year}`) ? full.slice(0, -`, ${year}`.length) : full;
}

function statusLabel(status: BillRow["status"]): string {
  const mark = status === "confirmed" ? '<span class="seal" aria-hidden="true">定</span>' : '<span class="seal-slot" aria-hidden="true"></span>';
  return `${mark}<span class="word">${STATUS_WORD[status]}</span><span class="live" aria-hidden="true"></span>`;
}

function payerChip(v: View): string {
  const name = escapeHtml(nameOf(v, v.bill.payerId));
  const inner = `${icon("coin")}<span class="sr">Paid by </span><span class="name">${name}</span>`;
  // Only a member can be handed the bill, and only while nobody has paid it.
  return v.s.editable === "all" && !v.s.hasPayments
    ? `<button type="button" class="payer-chip" data-open-payer aria-haspopup="dialog">${inner}${BRUSH}</button>`
    : `<span class="payer-chip">${inner}</span>`;
}

function header(v: View): string {
  const date = shortDate(v.bill.billDate, v.year);
  return `<header class="head">
<h1>${escapeHtml(v.bill.place?.trim() || "Receipt")}</h1>
<p class="status" data-status-label>${statusLabel(v.bill.status)}</p>
<p class="meta">${date ? `<span>${date}</span><span aria-hidden="true">·</span>` : ""}<span data-payer-slot>${payerChip(v)}</span></p>
</header>
<p class="toast" data-live-note role="status" hidden></p>`;
}

function notOnBill(v: View): string {
  const draft = v.bill.status === "draft";
  return `<section class="card notice-card" data-you>
<h2>You're not on this bill</h2>
<p>${draft ? "If you were at dinner, tap <strong>Open the split</strong> on the bill in Discord to join it." : "Nothing here is yours to pay."}</p>
</section>`;
}

function rowLabel(v: View, item: LineItem): string {
  const others = item.claimedBy.filter((id) => id !== v.s.viewer).map((id) => nameOf(v, id));
  return `${item.label}${item.addons ? ` (${formatAddons(item.addons)})` : ""}, ${formatCents(item.cents)}${others.length > 0 ? `, with ${others.join(", ")}` : ""}`;
}

function piece(v: View, item: LineItem): string {
  const n = item.claimedBy.length;
  const mine = itemPieces(item).get(v.s.viewer);
  if (mine === undefined || n < 2) return `<span class="piece"></span>`;
  return `<span class="piece">÷${n}<span class="money">${formatCents(mine)}</span></span>`;
}

const CHECK_TICK = `<span class="tick" aria-hidden="true">${icon("check")}</span>`;

// Three shapes: the payer can tap the tick (their own claim) apart from the
// rest of the line (who had it, and fixing it); a member taps the whole line
// for their own claim; anyone else sees it locked.
// The short line under a dish. Each priced add-on's amount is a pill with a
// brush when the payer can change it, like the dish's own price, and its index
// lets a tap on it open the editor at that price.
function addonsLine(addons: Addon[], brush: string): string {
  return addons
    .map((a, i) => {
      if (a.cents === 0) return escapeHtml(a.label);
      const amount = `${a.cents > 0 ? "+" : ""}${formatCents(a.cents)}`;
      return `${escapeHtml(a.label)} ${brush ? `<span class="addon-amt" data-addon-index="${i}">${amount}${brush}</span>` : amount}`;
    })
    .join(", ");
}

function itemRow(v: View, item: LineItem): string {
  const mine = item.claimedBy.includes(v.s.viewer);
  const unclaimed = item.claimedBy.length === 0;
  const others = item.claimedBy.filter((id) => id !== v.s.viewer);
  const brush = v.s.editable === "all" ? BRUSH : "";
  const inner =
    `<span class="item-label">${escapeHtml(item.label)}</span><span class="item-price">${formatCents(item.cents)}${brush}</span>` +
    (item.addons ? `<span class="item-addons">${addonsLine(item.addons, brush)}</span>` : "") +
    `<span class="who">${stack(v, others, 5)}</span>${piece(v, item)}`;
  const id = escapeHtml(item.id);
  const classes = ["item", mine ? "is-mine" : "", unclaimed ? "is-unclaimed" : "", others.length === 0 ? "is-bare" : "", item.addons ? "has-addons" : ""];
  const claim = `data-claim data-item="${id}" data-participant="${escapeHtml(v.s.viewer)}" aria-pressed="${mine}"`;
  if (v.s.editable === "all") {
    classes.push("has-picker");
    return `<li class="${classes.filter(Boolean).join(" ")}" data-item="${id}">
<button type="button" class="tick-btn" ${claim} aria-label="${escapeHtml(`${item.label}, ${nameOf(v, v.s.viewer)}`)}">${CHECK_TICK}</button>
<button type="button" class="row" data-open-line="${id}" aria-haspopup="dialog" aria-label="${escapeHtml(rowLabel(v, item))}">${inner}</button>
</li>`;
  }
  if (v.s.editable === "self") {
    return `<li class="${classes.filter(Boolean).join(" ")}" data-item="${id}">
<button type="button" class="row" ${claim} aria-label="${escapeHtml(rowLabel(v, item))}">${CHECK_TICK}${inner}</button>
</li>`;
  }
  classes.push("is-locked");
  return `<li class="${classes.filter(Boolean).join(" ")}" data-item="${id}"><div class="row">${CHECK_TICK}${inner}</div></li>`;
}

// "Tax (8.2%)": the share of the subtotal, to one decimal, read as part of
// the label.
function withPercent(label: string, part: Cents, subtotal: Cents): string {
  return subtotal > 0 ? `${label} (${((part * 100) / subtotal).toFixed(1)}%)` : label;
}

function receiptMark(s: BillState): string {
  const gap = s.reconciles.discrepancyCents;
  if (s.reconciles.ok && s.printedTotalCents !== null) return `<span class="mark">${icon("check")}<span class="sr">Adds up</span></span>`;
  if (s.printedTotalCents === null || gap === null) return `<span class="mark">${icon("warn")}<span class="sr">Not entered</span></span>`;
  return `<span class="mark">${icon("warn")}<span>${gap > 0 ? "+" : "−"}${formatCents(Math.abs(gap))}</span></span>`;
}

// The payer's editable amounts are their own buttons, so the row reads as
// plain figures to everyone else and as figures to fix to the one who paid.
function amount(v: View, field: string, key: string, cents: Cents | null, label: string): string {
  const shown = `<span data-total="${key}">${cents === null ? "—" : formatCents(cents)}</span>`;
  if (v.s.editable !== "all") return shown;
  return `<button type="button" class="amt" data-edit-field="${field}" aria-label="${label}, ${cents === null ? "not entered" : formatCents(cents)}">${shown}${BRUSH}</button>`;
}

function totals(v: View): string {
  const s = v.s;
  const r = s.result;
  const rows = [
    `<div class="trow"><dt>Subtotal</dt><dd data-total="subtotal">${formatCents(r.billSubtotalCents)}</dd></div>`,
    `<div class="trow" data-field-row="tax"><dt>${withPercent("Tax", s.taxCents, r.billSubtotalCents)}</dt><dd>${amount(v, "tax", "tax", s.taxCents, "Tax")}</dd></div>`,
  ];
  // Between tax and tip, because the printed total is what the restaurant
  // charged before anyone added a tip: it reads as the sum of the two above.
  if (v.s.viewerIsPayer && v.bill.status === "draft") {
    rows.push(
      `<div class="trow receipt-row ${s.reconciles.ok ? "is-ok" : "is-off"}" data-reconcile data-field-row="printedTotal">` +
        `<dt>Receipt ${receiptMark(s)}</dt><dd>${amount(v, "printedTotal", "printed", s.printedTotalCents, "Printed total")}</dd></div>`,
    );
  }
  rows.push(
    `<div class="trow" data-field-row="tip"><dt>${withPercent("Tip", s.tipCents, r.billSubtotalCents)}</dt><dd>${amount(v, "tip", "tip", s.tipCents, "Tip")}</dd></div>`,
    `<div class="trow grand"><dt>Total</dt><dd data-total="total">${formatCents(r.distributableCents)}</dd></div>`,
  );
  if (r.unclaimedCents !== 0) {
    rows.push(
      `<div class="trow short"><dt><span class="dash-ring" aria-hidden="true"></span>Unclaimed</dt><dd data-total="unclaimed">${formatCents(r.unclaimedCents)}</dd></div>`,
    );
  }
  return `<dl class="totals" data-totals>${rows.join("")}</dl>`;
}

function receipt(v: View): string {
  const list = v.s.items.length > 0 ? `<ul class="items">${v.s.items.map((i) => itemRow(v, i)).join("\n")}</ul>` : "";
  const add =
    v.s.editable === "all"
      ? `<div class="add-line needs-js" data-add-line><button type="button" class="add-row" data-add-open aria-label="Add a line">${icon("plus")}</button></div>`
      : "";
  return `<section class="card receipt${v.s.editable === "all" ? " is-editable" : ""}" data-items aria-label="Receipt">
${list}
${add}
${totals(v)}
</section>`;
}

function tileBadges(v: View, p: StateParticipant): string {
  const guests = guestsOf(v, p.id);
  return [
    p.id === v.bill.payerId ? `<span class="badge coin" aria-hidden="true">${icon("coin")}</span>` : "",
    forgivenWhole(v, p.id) ? `<span class="badge gift" aria-hidden="true">${icon("gift")}</span>` : "",
    guests.length > 0 ? `<span class="minis" aria-hidden="true">${guests.slice(0, 2).map((g) => av(v, g.id)).join("")}</span>` : "",
    paidUp(v, p.id) ? `<span class="stamp" aria-hidden="true">付讫</span>` : "",
  ].join("");
}

function tileLabel(v: View, p: StateParticipant): string {
  const guests = guestsOf(v, p.id).map((g) => g.displayName);
  const parts = [
    `${p.displayName}${p.id === v.s.viewer ? " (you)" : ""}`,
    formatCents(owedOf(v, p.id)),
    ...(guests.length > 0 ? [`with ${guests.join(", ")}`] : []),
    ...(p.id === v.bill.payerId ? ["paid the bill"] : []),
    ...(forgivenWhole(v, p.id) ? ["forgiven"] : []),
    ...(paidUp(v, p.id) ? ["paid"] : []),
  ];
  return parts.join(", ");
}

function tileAmount(v: View, p: StateParticipant): string {
  const forgiven = forgivenWhole(v, p.id);
  const cents = forgiven
    ? [p.id, ...guestsOf(v, p.id).map((g) => g.id)].reduce((n, id) => n + (v.shares.get(id)?.owedCents ?? 0), 0)
    : owedOf(v, p.id);
  return `<span class="tile-amt money${forgiven ? " is-forgiven" : ""}" data-owed="${escapeHtml(p.id)}">${formatCents(cents)}</span>`;
}

function tile(v: View, p: StateParticipant): string {
  const viewer = p.id === v.s.viewer;
  return `<li><button type="button" class="tile${viewer ? " is-viewer" : ""}" data-person="${escapeHtml(p.id)}" aria-haspopup="dialog" aria-label="${escapeHtml(tileLabel(v, p))}">
<span class="avw">${av(v, p.id)}${tileBadges(v, p)}</span><span class="tile-name">${escapeHtml(p.displayName)}</span>${tileAmount(v, p)}</button></li>`;
}

// Anyone on a draft can bring a guest, right where the people are.
function addGuestTile(v: View): string {
  if (v.bill.status !== "draft" || !v.onBill) return "";
  return `<li class="needs-js" data-add-guest-slot><button type="button" class="tile add-tile" data-add-guest>
<span class="avw"><span class="av" aria-hidden="true">${icon("plus")}</span></span><span class="tile-name">Guest</span><span class="tile-amt">&nbsp;</span></button></li>`;
}

function people(v: View): string {
  return `<section data-people aria-label="People">
<ul class="people">${membersFirst(v).map((p) => tile(v, p)).join("\n")}${addGuestTile(v)}</ul>
</section>`;
}

// You first, then the guests you brought. Nobody else's: the payer settles
// other people's lines from the line itself. Each chip carries a name, your
// own too, so the pressed one says whose lines a tap claims, and that
// person's share, so the total beside them reads as theirs added up.
function claimers(v: View): string {
  const ids = [v.s.viewer, ...guestsOf(v, v.s.viewer).map((g) => g.id)];
  const chips = ids.map(
    (id) =>
      `<button type="button" class="claimer" data-claim-as="${escapeHtml(id)}" aria-pressed="${id === v.s.viewer}">` +
      `${av(v, id)}<span class="label">${escapeHtml(nameOf(v, id))}</span>` +
      `<span class="chip-amt money">${formatCents(v.shares.get(id)?.owedCents ?? 0)}</span></button>`,
  );
  const hidden = v.s.editable !== "none" && ids.length > 1 ? "" : " hidden";
  return `<div class="claimers" data-claimers role="group" aria-label="Claim for"${hidden}>${hidden ? "" : chips.join("")}</div>`;
}

function bar(v: View): string {
  if (!v.onBill) return "";
  const s = v.s;
  const open = s.items.filter((i) => i.claimedBy.length === 0).length;
  const ring =
    open > 0
      ? `<button type="button" class="ring-btn" data-jump-unclaimed aria-label="${open} left to claim"><span class="dash-ring" aria-hidden="true"></span>${open} left</button>`
      : "";
  const [label, cents] = s.viewerIsPayer ? ["to collect", s.payerCollectsCents] : ["you owe", owedOf(v, s.viewer)];
  const content =
    `<span class="owe"><span class="owe-label">${label}</span> <span class="amount money" data-you-owed>${formatCents(cents)}</span></span>` +
    `${icon("arrow", "arrow")}${av(v, s.payerId, "payer")}`;
  return `<div class="bar" data-bar>${claimers(v)}<div class="bar-in">${content}<span class="grow"></span>${ring}</div></div>`;
}

// Food, tax and tip of what is asked for after pardons and after any guest
// who paid the payer directly. Payments are not taken off: paid is yes or
// no, and the stamp says which.
function counted(v: View, id: ParticipantId): Share[] {
  const own = v.shares.get(id);
  const guests = guestsOf(v, id)
    .filter((g) => debtorOf(g, v.bill.payerId) === id && g.paidToPayer !== true)
    .map((g) => v.shares.get(g.id));
  return [own, ...guests].filter((x): x is Share => !!x && !x.pardoned);
}

function splitParts(shares: Share[]): { food: Cents; tax: Cents; tip: Cents } {
  return shares.reduce((n, x) => ({ food: n.food + x.subtotalCents, tax: n.tax + x.taxCents, tip: n.tip + x.tipCents }), { food: 0, tax: 0, tip: 0 });
}

function splitBar(parts: { food: Cents; tax: Cents; tip: Cents }): string {
  const seg = (cls: string, cents: Cents) => (cents > 0 ? `<span class="${cls}" style="flex:${cents}"></span>` : "");
  const label = `Food ${formatCents(parts.food)}, Tax ${formatCents(parts.tax)}, Tip ${formatCents(parts.tip)}`;
  return `<div class="split-bar" role="img" aria-label="${label}">${seg("food", parts.food)}${seg("tax", parts.tax)}${seg("tip", parts.tip)}</div>
<p class="legend" data-you-detail><span><span class="key food" aria-hidden="true"></span>${icon("bowl")}<span class="sr">Food</span><span class="money">${formatCents(parts.food)}</span></span>` +
    `<span><span class="key tax" aria-hidden="true"></span>Tax <span class="money">${formatCents(parts.tax)}</span></span>` +
    `<span><span class="key tip" aria-hidden="true"></span>Tip <span class="money">${formatCents(parts.tip)}</span></span></p>`;
}

function pie(done: Cents, total: Cents): string {
  const c = 2 * Math.PI * 22;
  const f = total > 0 ? Math.min(1, done / total) : 0;
  return `<svg class="pie" viewBox="0 0 54 54" aria-hidden="true"><circle class="track" cx="27" cy="27" r="22"/>` +
    `${f > 0 ? `<circle class="done" cx="27" cy="27" r="22" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}"/>` : ""}</svg>`;
}

// With no app link to offer, "I paid" stands alone: the person pays the
// way they usually would and records it here after.
function payRow(v: View): string {
  const links = v.s.pay.map(
    (o) => `<a class="pay" href="${escapeHtml(o.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(o.name)}${icon("out")}</a>`,
  );
  return links.length > 0 ? `<div class="pay-row" data-pay>${links.join("")}</div>` : "";
}

// Only someone with something left to pay has anything to record. Paid is
// yes or no, so the tap records all of it, with nothing to ask first.
function sentRow(v: View): string {
  if (leftOf(v, v.s.viewer) <= 0) return "";
  return `<div class="sent-row needs-js" data-sent><button type="button" class="sent" data-pay-all>${icon("check")}I paid</button></div>`;
}

// One amount for you and the guests you brought, then whose it is: you
// first, then each guest. A paid guest gets the stamp, which says it without
// words. One who paid the payer directly is also off the amount, so the row
// is greyed.
function whoRows(v: View): string {
  const s = v.s;
  const guests = guestsOf(v, s.viewer);
  if (guests.length === 0) return "";
  const stamp = `<span class="stamp" role="img" aria-label="Paid">付讫</span>`;
  const row = (id: ParticipantId, name: string, paid: boolean, off: boolean) => {
    const share = v.shares.get(id);
    const forgiven = share?.pardoned === true;
    const cls = forgiven ? " is-forgiven is-off" : off ? " is-off" : "";
    return `<li${off ? ' class="is-off"' : ""}>${av(v, id)}<span class="name">${escapeHtml(name)}</span>${paid ? stamp : ""}` +
      `<span class="note">${forgiven ? "forgiven" : ""}</span><span class="money${cls}">${formatCents(share?.owedCents ?? 0)}</span></li>`;
  };
  const rows = [
    row(s.viewer, "You", false, false),
    ...guests.map((g) => row(g.id, g.displayName, guestPaid(v, g), g.paidToPayer === true)),
  ];
  return `<ul class="whose" data-who aria-label="Whose share">${rows.join("")}</ul>`;
}

// The bill's whole debt to the payer next to what has come in, so the big
// number above reads as what is still out.
function collectedOf(done: Cents, total: Cents): string {
  return `<p class="legend"><span><span class="money">${formatCents(total)}</span> owed to you · <span class="money">${formatCents(done)}</span> paid</span></p>`;
}

function hero(v: View): string {
  const s = v.s;
  const arrow = icon("arrow", "arrow");
  if (s.viewerIsPayer) {
    const debtors = Object.keys(s.owing).filter((id) => id !== s.viewer && owedOf(v, id) > 0);
    const total = debtors.reduce((n, id) => n + owedOf(v, id), 0);
    const left = debtors.reduce((n, id) => n + leftOf(v, id), 0);
    return `<section class="card hero is-payer" data-you aria-label="Owed to you">
<div class="flow">${stack(v, debtors, 4)}${arrow}${av(v, s.viewer)}</div>
<p class="hero-cap">to collect</p>
<div class="collect"><p class="hero-amt money" data-you-owed>${formatCents(left)}</p>${pie(total - left, total)}</div>
${collectedOf(total - left, total)}
</section>`;
  }
  // A guest who paid the payer directly is no longer part of what the viewer pays.
  const mine = [s.viewer, ...guestsOf(v, s.viewer).filter((g) => g.paidToPayer !== true).map((g) => g.id)];
  const forgiven = forgivenWhole(v, s.viewer);
  const paid = paidUp(v, s.viewer);
  const was = forgiven
    ? `<p class="was money">${formatCents(mine.reduce((n, id) => n + (v.shares.get(id)?.owedCents ?? 0), 0))}</p>`
    : "";
  const marks = paid
    ? `<span class="stamp" role="img" aria-label="Paid">付讫</span>`
    : forgiven
      ? `<span class="gift-mark" role="img" aria-label="Forgiven">${icon("gift")}</span>`
      : "";
  // With guests the bar would mix their food, tax and tip in with the
  // viewer's. Each person's lines below add up to their own amount instead.
  const split = forgiven || guestsOf(v, s.viewer).length > 0 ? "" : splitBar(splitParts(counted(v, s.viewer)));
  return `<section class="card hero${paid ? " is-paid" : ""}${forgiven ? " is-forgiven" : ""}" data-you aria-label="Your share">
<div class="flow">${stack(v, mine, 3)}${arrow}${av(v, s.payerId)}</div>
${was}<p class="hero-amt money" data-you-owed>${formatCents(paid || forgiven ? 0 : leftOf(v, s.viewer))}</p>${marks}
${whoRows(v)}
${split}
${paid ? "" : payRow(v)}
${sentRow(v)}
</section>`;
}

// Tax and tip are the share's own, from the split, so the lines add up to
// that person's amount to the cent.
function taxTipRows(v: View, id: ParticipantId): string {
  const share = v.shares.get(id);
  if (!share) return "";
  const row = (label: string, cents: Cents) => `<li class="tax-tip"><span class="item-label">${label}</span><span class="money">${formatCents(cents)}</span></li>`;
  return row("Tax", share.taxCents) + row("Tip", share.tipCents);
}

function mineList(v: View, id: ParticipantId, withTaxTip: boolean): string {
  const rows = v.s.items
    .filter((i) => i.claimedBy.includes(id))
    .map((item) => {
      const n = item.claimedBy.length;
      const cents = itemPieces(item).get(id) ?? 0;
      return `<li><span class="item-label">${escapeHtml(item.label)}</span>${n > 1 ? `<span class="piece">÷${n}</span>` : ""}<span class="money">${formatCents(cents)}</span></li>`;
    });
  return rows.length > 0 ? `<ul>${rows.join("")}${withTaxTip ? taxTipRows(v, id) : ""}</ul>` : "";
}

// Grouped the way the amount is broken down: yours, then each guest's, each
// ending in its tax and tip so it adds up to that person's amount up top. No
// amount on the headings, since the rows above already say it. A paid
// guest's stamp is on their row up top, not here again. A diner alone needs
// no heading, since the card above is their share. The payer's card above is
// what others owe, so their own lines say whose they are.
function mine(v: View): string {
  const withTaxTip = guestsOf(v, v.s.viewer).length > 0;
  const own = mineList(v, v.s.viewer, withTaxTip);
  const guests = guestsOf(v, v.s.viewer)
    .map((g) => {
      const list = mineList(v, g.id, withTaxTip);
      return list ? `<div class="mine-group"><p class="mine-guest">${av(v, g.id)}${escapeHtml(g.displayName)}</p>${list}</div>` : "";
    })
    .join("");
  if (!own && !guests) return "";
  const yours =
    own && (guests || v.s.viewerIsPayer) ? `<div class="mine-group"><p class="mine-guest">${av(v, v.s.viewer)}You</p>${own}</div>` : own;
  return `<section class="card mine" data-mine aria-label="Your lines">${yours}${guests}</section>`;
}

function drill(v: View): string {
  const members = membersFirst(v).map((p) => p.id);
  const debtors = Object.keys(v.s.owing).filter((id) => id !== v.bill.payerId && owedOf(v, id) > 0);
  const done = debtors.filter((id) => paidUp(v, id)).length;
  return `<nav class="card drill" aria-label="More">
<a class="drill-row" href="#receipt" data-go="receipt">${icon("receipt")}<span class="grow">Total</span><span class="money">${formatCents(v.s.result.distributableCents)}</span>${icon("chev")}</a>
<a class="drill-row" href="#people" data-go="people">${icon("people")}<span class="grow">${stack(v, members, 6)}</span>` +
    `${debtors.length > 0 ? `<span class="count">${done} of ${debtors.length} paid</span>` : ""}${icon("chev")}</a>
</nav>`;
}

// Why the payer can't confirm yet, in their words, or null when they can.
// The server refuses the same cases; this says so before the tap.
function confirmBlock(s: BillState): string | null {
  if (s.printedTotalCents === null) return "Enter the receipt total first.";
  if (!s.reconciles.ok) return "Line items do not add up to total!";
  if (!s.items.some((i) => i.claimedBy.length > 0)) return "Nobody has claimed anything yet.";
  return null;
}

function openLines(s: BillState): LineItem[] {
  return s.items.filter((i) => i.claimedBy.length === 0);
}

function confirmArea(v: View): string {
  const blocked = confirmBlock(v.s);
  const open = openLines(v.s).length;
  const why = blocked ?? (open === 0 ? "" : open === 1 ? "1 line has nobody on it." : `${open} lines have nobody on them.`);
  return `<div class="confirm-area"><button type="button" class="confirm-btn" data-confirm${blocked ? " disabled" : ""}${why ? ' aria-describedby="confirm-why"' : ""}>` +
    `<span class="brush" aria-hidden="true">定</span>Confirm</button>` +
    `${why ? `<p class="why${blocked ? "" : " is-hint"}" id="confirm-why">${escapeHtml(why)}</p>` : ""}</div>`;
}

function act(attrs: string, iconName: string, title: string, sub: string | null, cls = ""): string {
  return `<button type="button" class="act${cls ? ` ${cls}` : ""}" ${attrs}>${icon(iconName)}<span class="grow"><span>${escapeHtml(title)}</span>` +
    `${sub ? `<span class="act-sub">${escapeHtml(sub)}</span>` : ""}</span></button>`;
}

// The payer confirms, reopens to fix, and deletes. Anyone else on a
// confirmed bill can say something is wrong, which reopens it for the payer
// to fix. Nothing here for someone who is only claiming on a draft.
function actions(v: View): string {
  const s = v.s;
  const parts: string[] = [];
  if (s.viewerIsPayer) {
    if (v.bill.status === "draft") parts.push(confirmArea(v));
    if (v.bill.status === "confirmed") parts.push(act("data-reopen", "receipt", "Edit the bill", "Paying pauses until you confirm again."));
    parts.push(act("data-delete-bill", "trash", "Delete this bill", null, "danger"));
  } else if (v.bill.status === "confirmed" && v.onBill) {
    parts.push(
      act('data-ask="wrong" aria-haspopup="dialog"', "warn", "Something's wrong", `Paying pauses until ${nameOf(v, s.payerId)} fixes it.`, "is-warn"),
    );
  }
  if (parts.length === 0) return "";
  return `<section class="card acts needs-js" data-actions aria-label="Bill actions">${parts.join("")}</section>`;
}

interface PaidBy {
  id: ParticipantId;
  cents: Cents;
}

// Everyone who has paid, in roster order: paid is yes or no, so only those
// whose payments cover what they were asked for. A payment against a guest is
// the guest paying the payer directly, so it is measured against the guest's
// own share rather than what their member is asked for. A part payment made
// before that rule leaves the person unpaid, and off this list.
function paidBy(v: View): PaidBy[] {
  const paid = new Map<ParticipantId, Cents>();
  for (const p of v.s.payments) paid.set(p.participant, (paid.get(p.participant) ?? 0) + p.cents);
  return v.s.participants.flatMap((p) => {
    const share = v.shares.get(p.id);
    const asked = p.id in v.s.owing ? owedOf(v, p.id) : share && !share.pardoned ? share.owedCents : 0;
    return asked > 0 && (paid.get(p.id) ?? 0) >= asked ? [{ id: p.id, cents: asked }] : [];
  });
}

function paymentRows(v: View): string {
  const rows = paidBy(v).map((r) => {
    const name = escapeHtml(nameOf(v, r.id));
    return `<li>${av(v, r.id)}<span class="name">${name}</span><span class="money">${formatCents(r.cents)}</span>` +
      `<span class="stamp" role="img" aria-label="Paid">付讫</span>` +
      `<button type="button" class="chip-btn" data-undo-paid="${escapeHtml(r.id)}" aria-label="Undo ${name}'s payment">Undo</button></li>`;
  });
  return rows.length > 0 ? `<h2>Payments</h2><ul>${rows.join("")}</ul>` : "";
}

// Always drawn for the payer of a confirmed bill, hidden while empty, so the
// first payment has somewhere to appear without a reload.
function payments(v: View): string {
  if (!v.s.viewerIsPayer || v.bill.status !== "confirmed") return "";
  const rows = paymentRows(v);
  return `<section class="card payments needs-js" data-payments aria-label="Payments"${rows ? "" : " hidden"}>${rows}</section>`;
}

function back(): string {
  return `<a class="back needs-js" href="#" data-back>${icon("back")}<span class="sr">Back</span></a>`;
}

function body(v: View): string {
  if (layoutOf(v.bill.status) === "receipt") {
    return `${v.onBill ? "" : notOnBill(v)}
${receipt(v)}
${people(v)}
${actions(v)}
${bar(v)}`;
  }
  return `<div class="view is-active" data-view="home">
${v.onBill ? `${hero(v)}\n${payments(v)}\n${mine(v)}` : notOnBill(v)}
${drill(v)}
${actions(v)}
</div>
<div class="view" data-view="receipt" id="receipt">${back()}
${receipt(v)}
</div>
<div class="view" data-view="people" id="people">${back()}
${people(v)}
</div>`;
}

export function renderPage(
  bill: BillRow,
  result: SplitResult,
  items: LineItem[],
  participants: Participant[],
  viewer: ParticipantId,
  extras: StateExtras = {},
  nowMs: number = Date.now(),
): string {
  const s = billState(bill, result, items, participants, viewer, extras.hasPayments ?? false, extras.paid ?? [], extras, extras);
  const v: View = {
    bill,
    s,
    people: new Map(s.participants.map((p) => [p.id, p])),
    shares: new Map(result.shares.map((x) => [x.participant, x])),
    onBill: s.participants.some((p) => p.id === viewer),
    year: new Date(nowMs).getUTCFullYear(),
  };
  const layout = layoutOf(bill.status);

  const main = `${sprite()}
<main class="page${layout === "receipt" && v.onBill ? " has-bar" : ""}" id="bill" data-bill-id="${escapeHtml(bill.id)}" data-viewer="${escapeHtml(viewer)}" data-payer="${escapeHtml(bill.payerId)}" data-viewer-is-payer="${s.viewerIsPayer}" data-editable="${s.editable}" data-status="${bill.status}" data-revision="${bill.revision}" data-layout="${layout}">
${header(v)}
${body(v)}
</main>
<script type="application/json" id="bill-state">${scriptJson(s)}</script>
<script>${CLIENT_SCRIPT}</script>`;

  return shell(`${bill.place?.trim() || "Receipt"} · AAzhi`, main);
}
