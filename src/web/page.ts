import type { BillRow, Participant } from "../db/bills";
import { formatCents, formatDate } from "../format";
import { debtorOf } from "../money/debtors";
import { itemPieces } from "../money/split";
import type { Cents, LineItem, ParticipantId, Share, SplitResult } from "../money/types";
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
/* One look for "tap to change": a brush after the value. Read-only values
   carry none. */
.ic.brush { width: 21px; height: 21px; color: var(--muted); stroke-width: 1.5; }
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
button.payer-chip {
  margin: -7px -6px;
  padding: 7px 6px;
  min-height: 44px;
  border: 0;
  background: none;
  cursor: pointer;
}
/* Undoes the coin's size and colour, which the chip's icon rule gives every icon in it. */
button.payer-chip .brush { width: 21px; height: 21px; color: var(--muted); }

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
/* The figures' right edge. Where the payer can change them, it moves in so
   the brushes hang in the margin and every figure, brush or not, still lines
   up on one edge. */
.receipt { --end: 14px; }
.receipt.is-editable { --end: 39px; }
.row {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  grid-template-rows: 23px 22px;
  grid-template-areas: "tick name price" "tick who piece";
  column-gap: 10px;
  align-items: center;
  width: 100%;
  margin: 0;
  padding: 8px var(--end) 8px 4px;
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
.who { grid-area: who; display: flex; align-items: center; min-width: 0; }
.piece { grid-area: piece; justify-self: end; white-space: nowrap; font-size: 15px; color: var(--muted); }
.piece .money { color: var(--ink); margin-left: 4px; }
.has-picker .row .item-price, .amt { display: inline-flex; align-items: center; gap: 4px; margin-right: -25px; }
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
.add-line { padding: 8px 14px 4px 13px; }
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

/* Labels start on the ticks, like the add-a-line box, so the tick column
   is not left empty beside them. */
.totals { margin: 8px 0 0; padding: 0 var(--end) 10px 13px; }
.trow { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; }
.trow dt { display: flex; align-items: baseline; gap: 8px; color: var(--muted); min-width: 0; }
.trow dd { margin: 0; white-space: nowrap; }
.trow .pct { font-size: 15px; color: var(--muted); font-variant-numeric: tabular-nums; }
/* The left padding widens the tap target without moving the figure. */
.amt {
  min-height: 44px;
  margin-top: -2px;
  margin-bottom: -2px;
  margin-left: -12px;
  padding: 0 0 0 12px;
  border: 0;
  background: none;
  cursor: pointer;
}
.receipt-row dt { align-items: center; }
.receipt-row .mark { display: inline-flex; align-items: center; gap: 4px; font-size: 14px; }
.receipt-row.is-ok .mark { color: var(--ok); }
.receipt-row.is-off .mark { color: var(--warn); font-weight: 600; }
.receipt-row .mark .ic { width: 18px; height: 18px; }
/* A ledger's total: one rule above, a double rule below. The rules reach
   into the brush gutter to span the same width as the add-a-line box, and
   the padding keeps the figure in the figure column. */
.grand {
  margin: 6px calc(14px - var(--end)) 2px 0;
  padding: 4px calc(var(--end) - 14px) 4px 0;
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
/* The tip editor needs the card's full width at 390px, so it reaches into
   the gutter the figures leave for the brushes. */
.trow.is-editing { flex-wrap: wrap; margin-right: calc(14px - var(--end)); }

/* Its fields keep the width of the box it opens from. */
.line-form { display: grid; grid-template-columns: minmax(0, 1fr) 112px; gap: 8px; padding: 2px 0 8px; }
.line-form .actions { grid-column: 1 / -1; display: flex; gap: 8px; }
.line-form .actions .go { margin-left: auto; }
.line-form .field-msg { grid-column: 1 / -1; }
.sign { width: 44px; }

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
  max-width: 11em;
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
.pay-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.pay {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 46px;
  padding: 0 18px;
  border-radius: 23px;
  background: var(--seal);
  color: var(--seal-ink);
  font-weight: 600;
  text-decoration: none;
}
.pay .ic { width: 18px; height: 18px; }
.pay-note { flex-basis: 100%; color: var(--muted); font-size: 15px; }
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
.name-btn { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; min-height: 44px; margin: -4px 0; padding: 0; border: 0; background: none; font: inherit; text-align: left; cursor: pointer; }
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
  minus: '<path d="M5 12h14"/>',
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
  return `${item.label}, ${formatCents(item.cents)}${others.length > 0 ? `, with ${others.join(", ")}` : ""}`;
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
function itemRow(v: View, item: LineItem): string {
  const mine = item.claimedBy.includes(v.s.viewer);
  const unclaimed = item.claimedBy.length === 0;
  const others = item.claimedBy.filter((id) => id !== v.s.viewer);
  const brush = v.s.editable === "all" ? BRUSH : "";
  const inner =
    `<span class="item-label">${escapeHtml(item.label)}</span><span class="item-price">${formatCents(item.cents)}${brush}</span>` +
    `<span class="who">${stack(v, others, 5)}</span>${piece(v, item)}`;
  const id = escapeHtml(item.id);
  const classes = ["item", mine ? "is-mine" : "", unclaimed ? "is-unclaimed" : "", others.length === 0 ? "is-bare" : ""];
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

function percentOf(tip: Cents, subtotal: Cents): string {
  return subtotal > 0 ? `${Math.round((tip * 100) / subtotal)}%` : "";
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
  const pct = percentOf(s.tipCents, r.billSubtotalCents);
  const rows = [
    `<div class="trow"><dt>Subtotal</dt><dd data-total="subtotal">${formatCents(r.billSubtotalCents)}</dd></div>`,
    `<div class="trow" data-field-row="tax"><dt>Tax</dt><dd>${amount(v, "tax", "tax", s.taxCents, "Tax")}</dd></div>`,
  ];
  // Between tax and tip, because the printed total is what the restaurant
  // charged before anyone added a tip: where it sits says what it covers.
  if (v.s.viewerIsPayer && v.bill.status === "draft") {
    rows.push(
      `<div class="trow receipt-row ${s.reconciles.ok ? "is-ok" : "is-off"}" data-reconcile data-field-row="printedTotal">` +
        `<dt>Receipt ${receiptMark(s)}</dt><dd>${amount(v, "printedTotal", "printed", s.printedTotalCents, "Printed total")}</dd></div>`,
    );
  }
  rows.push(
    `<div class="trow" data-field-row="tip"><dt>Tip${pct ? ` <span class="pct">${pct}</span>` : ""}</dt><dd>${amount(v, "tip", "tip", s.tipCents, "Tip")}</dd></div>`,
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
// own too, so the pressed one says whose lines a tap claims.
function claimers(v: View): string {
  const ids = [v.s.viewer, ...guestsOf(v, v.s.viewer).map((g) => g.id)];
  const chips = ids.map(
    (id) =>
      `<button type="button" class="claimer" data-claim-as="${escapeHtml(id)}" aria-pressed="${id === v.s.viewer}">` +
      `${av(v, id)}<span class="label">${escapeHtml(nameOf(v, id))}</span></button>`,
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
// who paid the payer directly. Payments are not taken off: the paid-so-far
// line under it says how much of this is done.
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

function payRow(s: BillState): string {
  if (s.pay.length === 0) return "";
  const links = s.pay.map((o) =>
    "url" in o
      ? `<a class="pay" href="${escapeHtml(o.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(o.name)}${icon("out")}</a>`
      : `<p class="pay-note">${escapeHtml(o.instructions)}</p>`,
  );
  return `<div class="pay-row" data-pay>${links.join("")}</div>`;
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
<div class="collect"><p class="hero-amt money" data-you-owed>${formatCents(left)}</p>${pie(total - left, total)}</div>
<p class="legend"><span>${icon("check")}<span class="money">${formatCents(total - left)}</span> / <span class="money">${formatCents(total)}</span></span></p>
</section>`;
  }
  // A guest who paid the payer directly is no longer part of what the viewer pays.
  const mine = [s.viewer, ...guestsOf(v, s.viewer).filter((g) => g.paidToPayer !== true).map((g) => g.id)];
  const forgiven = forgivenWhole(v, s.viewer);
  const paid = paidUp(v, s.viewer);
  const o = s.owing[s.viewer];
  const partial = o && o.paidCents > 0 && !paid;
  const was = forgiven
    ? `<p class="was money">${formatCents(mine.reduce((n, id) => n + (v.shares.get(id)?.owedCents ?? 0), 0))}</p>`
    : "";
  const marks = paid
    ? `<span class="stamp" role="img" aria-label="Paid">付讫</span>`
    : forgiven
      ? `<span class="gift-mark" role="img" aria-label="Forgiven">${icon("gift")}</span>`
      : "";
  const parts = splitParts(counted(v, s.viewer));
  return `<section class="card hero${paid ? " is-paid" : ""}${forgiven ? " is-forgiven" : ""}" data-you aria-label="Your share">
<div class="flow">${stack(v, mine, 3)}${arrow}${av(v, s.payerId)}</div>
${was}<p class="hero-amt money" data-you-owed>${formatCents(paid || forgiven ? 0 : leftOf(v, s.viewer))}</p>${marks}
${forgiven ? "" : splitBar(parts)}
${partial ? `<p class="legend"><span>${icon("check")}<span class="money">${formatCents(o.paidCents)}</span> / <span class="money">${formatCents(o.owedCents)}</span></span></p>` : ""}
${paid ? "" : payRow(s)}
</section>`;
}

function mineList(v: View, id: ParticipantId): string {
  const rows = v.s.items
    .filter((i) => i.claimedBy.includes(id))
    .map((item) => {
      const n = item.claimedBy.length;
      const cents = itemPieces(item).get(id) ?? 0;
      return `<li><span class="item-label">${escapeHtml(item.label)}</span>${n > 1 ? `<span class="piece">÷${n}</span>` : ""}<span class="money">${formatCents(cents)}</span></li>`;
    });
  return rows.length > 0 ? `<ul>${rows.join("")}</ul>` : "";
}

function mine(v: View): string {
  const own = mineList(v, v.s.viewer);
  const guests = guestsOf(v, v.s.viewer)
    .map((g) => {
      const list = mineList(v, g.id);
      // These are the viewer's own guests, so either mark is theirs to see.
      const paid = g.paidToPayer || g.paidToHost ? `<span class="stamp" role="img" aria-label="Paid">付讫</span>` : "";
      return list ? `<div class="mine-group"><p class="mine-guest">${av(v, g.id)}${escapeHtml(g.displayName)}${paid}</p>${list}</div>` : "";
    })
    .join("");
  if (!own && !guests) return "";
  return `<section class="card mine" data-mine aria-label="Your lines">${own}${guests}</section>`;
}

function drill(v: View): string {
  const members = membersFirst(v).map((p) => p.id);
  const debtors = Object.keys(v.s.owing).filter((id) => id !== v.bill.payerId && owedOf(v, id) > 0);
  const done = debtors.filter((id) => paidUp(v, id)).length;
  return `<nav class="card drill" aria-label="More">
<a class="drill-row" href="#receipt" data-go="receipt">${icon("receipt")}<span class="grow">Total</span><span class="money">${formatCents(v.s.result.distributableCents)}</span>${icon("chev")}</a>
<a class="drill-row" href="#people" data-go="people">${icon("people")}<span class="grow">${stack(v, members, 6)}</span>` +
    `${debtors.length > 0 ? `<span class="count">付讫 ${done}/${debtors.length}</span>` : ""}${icon("chev")}</a>
</nav>`;
}

function back(): string {
  return `<a class="back needs-js" href="#" data-back>${icon("back")}<span class="sr">Back</span></a>`;
}

function body(v: View): string {
  if (layoutOf(v.bill.status) === "receipt") {
    return `${v.onBill ? "" : notOnBill(v)}
${receipt(v)}
${people(v)}
${bar(v)}`;
  }
  return `<div class="view is-active" data-view="home">
${v.onBill ? `${hero(v)}\n${mine(v)}` : notOnBill(v)}
${drill(v)}
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
