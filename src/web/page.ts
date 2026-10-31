import type { BillRow, Participant } from "../db/bills";
import { formatAddons, formatCents, formatDate } from "../format";
import { debtorOf } from "../money/debtors";
import { itemPieces } from "../money/split";
import type { Addon, Cents, LineItem, ParticipantId, Share, SplitResult } from "../money/types";
import { CEREMONY_STYLES } from "./ceremony";
import { CLIENT_SCRIPT } from "./client";
import { FONT_FACES } from "./fonts";
import { billState, type BillState, type StateParticipant, type StateExtras } from "./state";

export type { Editable } from "./state";

// Covers text and double-quoted attribute values alike; every attribute this
// file writes is double-quoted.
export function escapeHtml(text: string): string {
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
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// Xuan paper: a fine grain, long fibres laid mostly one way, and the faint
// clouding where the sheet drank the ink unevenly. Each layer is one tile the
// browser rasterizes once, so it costs nothing to scroll. Each filter covers
// exactly the tile: the default region overhangs it by 10% a side, and the
// stitched noise then repeats out of step and leaves a seam every tile.
function paper(rgb: string, grain: number, fibre: number, cloud: number): string {
  const tint = (alpha: string) => `0 0 0 0 ${rgb} 0 0 0 0 ${rgb} 0 0 0 0 ${rgb} ${alpha}`;
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='260' height='260'>" +
    "<filter id='g' x='0' y='0' width='1' height='1'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/>" +
    `<feColorMatrix values='${tint(`0 0 0 ${grain} 0`)}'/></filter>` +
    "<filter id='f' x='0' y='0' width='1' height='1'><feTurbulence type='fractalNoise' baseFrequency='.012 .25' numOctaves='3' seed='7' stitchTiles='stitch'/>" +
    `<feColorMatrix values='${tint(`0 0 0 ${(fibre * 4).toFixed(3)} ${(-fibre * 1.6).toFixed(3)}`)}'/></filter>` +
    "<filter id='c' x='0' y='0' width='1' height='1'><feTurbulence type='fractalNoise' baseFrequency='.006' numOctaves='2' seed='3' stitchTiles='stitch'/>" +
    `<feColorMatrix values='${tint(`0 0 0 ${cloud} 0`)}'/></filter>` +
    "<rect width='100%' height='100%' filter='url(%23c)'/><rect width='100%' height='100%' filter='url(%23f)'/>" +
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

// The sheet's top edge: a far ridge instead of a ruler-straight lip. The same
// line masks the sheet and is drawn along it, so the two always agree.
const RIDGE = "M0 24C14 20 30 10 46 7C56 5 62 12 72 16C82 20 94 6 106 3C116 1 122 10 134 15C150 21 166 12 184 10C200 8 210 18 224 16C236 14 242 4 252 2C262 0 270 10 282 14C298 19 314 9 330 7C344 5 354 16 368 17C378 18 385 15 390 14";

function svgUrl(svg: string): string {
  return `url("data:image/svg+xml,${svg.replace(/"/g, "'").replace(/#/g, "%23").replace(/</g, "%3C").replace(/>/g, "%3E")}")`;
}

function ridgeMask(): string {
  return svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 390 34' preserveAspectRatio='none'><path d='${RIDGE}V34H0Z'/></svg>`);
}

// Two washes of distant hills that fade into the sheet, painted once as a
// tile like the paper, so a sheet's redraws never rebuild them.
function sheetWash(far: string, mid: string, line: string): string {
  const fade = (id: string, color: string, alpha: number) =>
    `<linearGradient id='${id}' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${color}' stop-opacity='${alpha}'/>` +
    `<stop offset='.55' stop-color='${color}' stop-opacity='${(alpha * 0.75).toFixed(3)}'/><stop offset='1' stop-color='${color}' stop-opacity='0'/></linearGradient>`;
  return svgUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 390 90' preserveAspectRatio='none'>" +
      fade("a", far, 0.32) + fade("b", mid, 0.26) +
      "<filter id='r' x='-2%' y='-10%' width='104%' height='120%'><feTurbulence type='fractalNoise' baseFrequency='.035 .08' numOctaves='2' seed='4'/>" +
      "<feDisplacementMap in='SourceGraphic' scale='5'/></filter>" +
      // The washes run a little past both sides, since the rough edge would
      // otherwise pull in from the sheet's corners and leave a notch.
      "<g transform='translate(-8 0) scale(1.041 1)'>" +
      `<path fill='url(#a)' filter='url(#r)' d='${RIDGE}V90H0Z'/>` +
      "<path fill='url(#b)' filter='url(#r)' d='M0 44C30 34 50 26 80 30C110 34 120 44 150 40C180 36 196 24 226 26C256 28 270 42 300 40C330 38 350 28 390 32V90H0Z'/></g>" +
      `<path fill='none' stroke='${line}' stroke-width='1' vector-effect='non-scaling-stroke' d='${RIDGE}'/></svg>`,
  );
}

// A brush stroke that crosses a word out, heavy in the middle and lifting at
// the ends.
function strike(color: string): string {
  return svgUrl(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 14' preserveAspectRatio='none'><path fill='${color}' fill-opacity='.85' ` +
      "d='M2 8.5C40 5.5 90 6 150 5.2S260 4.6 298 6.2c1.4.1 1.4 1.6 0 1.7-40 2-110 2.3-170 2.8S30 11.8 4 11.2C.8 11.1.6 8.7 2 8.5z'/></svg>",
  );
}

// Water ripples, where a ledger would rule a line.
function ripple(color: string): string {
  return svgUrl(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 354 14' preserveAspectRatio='none'><g fill='none' stroke='${color}' stroke-width='1.1' stroke-linecap='round' vector-effect='non-scaling-stroke'>` +
      "<path stroke-opacity='.6' d='M0 6C29 2 59 10 88 6S147 2 177 6 236 10 265 6 324 2 354 6'/>" +
      "<path stroke-opacity='.33' d='M60 11.5c30-2.5 60 1 90-.5M200 11.5c30-2.5 60 1 90-.5'/></g></svg>",
  );
}

// Shan shui on xuan paper: a blue-green landscape by day, the same one under
// the moon by night. Azurite and malachite carry meaning, ochre marks what
// still needs someone, and cinnabar is kept for the seals. Every pair that
// carries meaning was checked against WCAG: 4.5:1 for text, 3:1 for the tick
// rings and seals. The avatar hues are mineral pigments, each a wash with its
// own ink, so an initial always reads.
const STYLES = `${FONT_FACES}${CEREMONY_STYLES}
:root {
  color-scheme: light dark;
  --paper: #efe7d6;
  --card: #f7f1e3;
  --ink: #1f1d1a;
  --muted: #5f584d;
  --ring: #8d8576;
  --line: #ddd3bf;
  --fill: #e8e0cf;
  --warn: #8f5222;
  --warn-soft: #f1e0c6;
  --ok: #3c7660;
  --ok-soft: #d8e6da;
  --azurite: #2f5d7c;
  --azurite-soft: #d9e3e4;
  --seal: #b3302a;
  --seal-ink: #fbf3ea;
  --focus: #2f5d7c;
  --rule: rgba(47, 93, 124, 0.2);
  --rule-strong: rgba(47, 93, 124, 0.5);
  --hill-far: #5f8fb0;
  --hill-mid: #5f9d7f;
  --moon: #fbf6ea;
  --food: #5f584d;
  --tax: #a89c86;
  --tip: #d9cdb6;
  --scrim: rgba(31, 29, 26, 0.38);
  --grain: ${paper(".28", 0.07, 0.035, 0.05)};
  --speckle: ${speckle()};
  --ridge: ${ridgeMask()};
  --sheet-wash: ${sheetWash("#5f8fb0", "#5f9d7f", "rgba(47, 93, 124, 0.5)")};
  --strike: ${strike("#1f1d1a")};
  --ripple: ${ripple("#2f5d7c")};
  /* A moss dot, the way a painter dabs malachite on a rock: what is yours. */
  --moss: radial-gradient(circle at 40% 35%, color-mix(in srgb, var(--ok) 80%, white) 0, var(--ok) 55%, color-mix(in srgb, var(--ok) 70%, black) 100%);
  --cjk-serif: "Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", "Noto Serif SC";
  --serif: "Iowan Old Style", "New York", ui-serif, "Noto Serif", "Source Serif Pro", Georgia, var(--cjk-serif), serif;
  --display: "Noto Serif Display", "Iowan Old Style", "New York", ui-serif, Georgia, serif;
  --brush: "Ma Shan Zheng", "Kaiti SC", "STKaiti", "KaiTi", "BiauKai", serif;
  --radius: 4px;
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
    --paper: #111417;
    --card: #181c20;
    --ink: #e9e3d6;
    --muted: #a49d90;
    --ring: #79736a;
    --line: #2d353b;
    --fill: #232a2f;
    --warn: #dba468;
    --warn-soft: #34271a;
    --ok: #8fc5ac;
    --ok-soft: #1b2a24;
    --azurite: #93b8d1;
    --azurite-soft: #1e2b35;
    --seal: #c84a3e;
    --seal-ink: #fff8f0;
    --focus: #93b8d1;
    --rule: rgba(147, 184, 209, 0.16);
    --rule-strong: rgba(147, 184, 209, 0.4);
    --hill-far: #3c5566;
    --hill-mid: #345247;
    --moon: #e9e1cc;
    --food: #cfc5b3;
    --tax: #8a806f;
    --tip: #4f473c;
    --scrim: rgba(0, 0, 0, 0.55);
    --grain: ${paper(".9", 0.05, 0.009, 0.04)};
    --sheet-wash: ${sheetWash("#3c5566", "#345247", "rgba(147, 184, 209, 0.4)")};
    --strike: ${strike("#e9e3d6")};
    --ripple: ${ripple("#93b8d1")};
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
/* "Tap to change" is a small brush just before the value. A figure stays a
   bare figure, so every amount on the card ends on one right edge whether
   the viewer can change it or not; a name keeps a tinted pill around it. */
.ic.brush { width: 16px; height: 16px; color: var(--muted); stroke-width: 1.6; }
.amt, .is-editable .item-price { display: inline-flex; align-items: center; gap: 5px; }
.amt { padding: 0; border: 0; background: none; color: inherit; }
button.payer-chip, .name-btn {
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
.amt:active .brush, .is-editable button.row:active .item-price .brush { color: var(--ink); }
button.payer-chip:active, .name-btn:active { background: var(--line); }
@media (hover: hover) {
  .amt:hover .brush, .is-editable button.row:hover .item-price .brush { color: var(--ink); }
  button.payer-chip:hover, .name-btn:hover { background: var(--line); }
}
/* A bare figure or a 30px pill is easier to see than to hit, so the buttons reach 44px. */
.amt, button.payer-chip, .name-btn { position: relative; cursor: pointer; }
.amt::after { content: ""; position: absolute; inset: -11px -6px; }
button.payer-chip::after, .name-btn::after { content: ""; position: absolute; inset: -7px -4px; }
.money, .item-price, .totals dd { font-variant-numeric: tabular-nums lining-nums; }
.page {
  --page-top: 18px;
  max-width: 480px;
  margin: 0 auto;
  padding: var(--page-top) 16px calc(28px + env(safe-area-inset-bottom));
}
.page[data-layout="receipt"].has-bar, .page[data-layout="log"].has-bar { padding-bottom: calc(100px + env(safe-area-inset-bottom)); }
/* Keyboard focus and claim mode scroll rows into view; keep them clear of the bar. */
html:has(.has-bar) { scroll-padding-bottom: calc(88px + env(safe-area-inset-bottom)); }
.needs-js { display: none; }
.is-live .needs-js:not([hidden]) { display: revert; }
/* Each card is a sheet laid on the paper, framed thick-and-thin in cinnabar
   like the border of a printed sutra page. */
/* The inset of every card's content. The receipt's tick circles sit this far
   in, and every figure on the page ends this far from the right, so amounts in
   stacked cards line up down the page. */
.card {
  --edge: 13px;
  background: var(--card) var(--grain);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  box-shadow: inset 0 0 0 3px var(--card), inset 0 0 0 3.75px var(--rule), 0 1px 2px rgba(60, 40, 10, 0.05);
}

/* A blue-green range, peaks clear and feet lost in mist. The SVG stretches to
   any width, so the moon sits outside it to stay round. */
.hills { position: relative; display: block; pointer-events: none; }
.hills > svg { display: block; width: 100%; height: 100%; }
.hills .far { fill: var(--hill-far); opacity: 0.5; }
.hills .mid { fill: var(--hill-mid); opacity: 0.55; }
.hills .moon { position: absolute; left: 82.4%; top: 21.7%; width: 26px; height: 26px; border-radius: 50%; background: var(--moon); opacity: 0.9; transform: translate(-50%, -50%); }
@media (prefers-color-scheme: dark) { .hills .far { opacity: 0.9; } }

/* The range runs across the top of the scroll, edge to edge of the page, and
   the title sits on the mist at its feet. */
.head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; align-items: start; padding: 0 2px 14px; }
.head > .hills { grid-column: 1 / -1; height: 120px; margin: calc(-1 * var(--page-top)) -18px -26px; }
/* A Chinese name wraps whole, as the dish names do, rather than leaving one
   character alone on the next line. */
.head h1 { position: relative; font-size: 25px; line-height: 1.2; font-weight: 600; overflow-wrap: anywhere; word-break: keep-all; }
.head .status, .head .meta { position: relative; }
.status { display: inline-flex; align-items: center; gap: 7px; height: 30px; font-size: 15px; color: var(--muted); white-space: nowrap; }
.seal-slot { width: 20px; height: 20px; border: 1.5px dashed var(--ring); border-radius: 3px; }
.seal {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 3px;
  background: var(--seal);
  color: var(--seal-ink);
  font: 19px/1 var(--brush);
  box-shadow: inset 0 0 0 1.5px var(--seal), inset 0 0 0 2.5px rgba(251, 243, 234, 0.7);
  transform: rotate(-6deg);
}
/* A draft carries the 稿 seal cut in outline, waiting for the red one. */
.seal.is-draft { background: none; color: var(--azurite); box-shadow: inset 0 0 0 1.6px var(--azurite); }
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

.receipt { position: relative; padding: 4px 0 6px; }
/* The scroll margin leaves room for the first line's focus ring when claim mode scrolls here. */
.items { list-style: none; margin: 0; padding: 0; scroll-margin-top: 16px; }
.item { position: relative; border-bottom: 1px solid var(--rule); }
/* A dish's name wraps rather than clipping, since at phone width a clipped
   name loses the part that tells two dishes apart. The price stays on its
   first line, so both are pinned to the top of the row. */
.row {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  grid-template-rows: minmax(23px, auto) 22px;
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
/* The line whose sheet is open, so the dish being edited is marked on the
   receipt as well as named in the sheet. */
.item.is-target { background: color-mix(in srgb, var(--azurite-soft) 70%, transparent); }
.row > .tick, .tick-btn { grid-area: tick; justify-self: center; }
/* Every claim circle sits on the first line of its dish's name, however many
   lines the name, its add-ons or its faces take: the 26px circle centred in
   the name's 23px line. */
.row > .tick { align-self: start; margin-top: -1.5px; }
/* Nobody else on the line means no avatars and no split, so the second line
   goes, and the padding takes its place so the row keeps its height. Claiming
   it yourself keeps it bare, so your own tap never moves rows. */
.is-bare .row { grid-template-rows: minmax(23px, auto); grid-template-areas: "tick name price"; padding-block: 11.5px; }
.is-bare .who, .is-bare .piece { display: none; }
/* keep-all so a Chinese dish name breaks between words, not inside 小笼包;
   anywhere still breaks a name too long for the line at all. */
.item-label { grid-area: name; align-self: start; min-width: 0; overflow-wrap: anywhere; word-break: keep-all; font-size: 17px; line-height: 23px; }
.item-price { grid-area: price; align-self: start; justify-self: end; white-space: nowrap; font-size: 17px; line-height: 23px; }
/* A dish's add-ons hang off a dashed azurite rule under its name, like a
   stream off a peak, the same dash that ties a guest's lines to them, so they
   read as part of the dish and not as lines of their own. Each price sits
   under the dish's. A long name wraps rather than clipping, since the add-ons
   explain the price, and its wrapped lines step in so they can't be read as
   the next add-on. */
.item-addons { grid-area: addons; display: block; min-width: 0; margin: 4px 0 2px 3px; padding-left: 11px; border-left: 1.5px dashed var(--azurite); font-size: 14px; line-height: 18px; color: var(--muted); }
/* Clear of the avatars below, so the rule doesn't seem to run into a face. */
.has-addons:not(.is-bare) .item-addons { margin-bottom: 7px; }
.addon-line { display: flex; align-items: baseline; gap: 10px; padding: 1px 0; }
.addon-name { flex: 1; min-width: 0; padding-left: 10px; text-indent: -10px; overflow-wrap: anywhere; word-break: keep-all; }
.addon-price { flex: none; white-space: nowrap; font-variant-numeric: tabular-nums lining-nums; }
.has-addons .row { grid-template-rows: minmax(23px, auto) auto 22px; grid-template-areas: "tick name price" ". addons addons" ". who piece"; }
.is-bare.has-addons .row { grid-template-rows: minmax(23px, auto) auto; grid-template-areas: "tick name price" ". addons addons"; }
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
  justify-items: center;
  align-items: start;
  /* A full-height button outside the grid, so it is pinned to the name's
     first line by hand: the row's padding, less the 1.5px the 26px circle
     overhangs the 23px line. */
  padding: 6.5px 0 0;
  border: 0;
  background: none;
  cursor: pointer;
}
.is-bare .tick-btn { padding-top: 10px; }
.tick {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1.6px solid var(--ring);
  color: var(--card);
}
.tick .ic { width: 17px; height: 17px; opacity: 0; }
.is-mine .tick { background: var(--moss); border-color: transparent; }
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
   malachite check on your lines, a small dashed ring on nobody's. */
.is-locked .tick { border-color: transparent; }
.is-locked.is-mine .tick { background: none; border-color: transparent; color: var(--ok); }
.is-locked.is-mine .tick .ic { width: 20px; height: 20px; }
.is-locked.is-unclaimed .tick { width: 18px; height: 18px; margin-top: 2.5px; border: 1.6px dashed var(--warn); }
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
  border: 1.5px dashed var(--rule-strong);
  border-radius: 10px;
  background: none;
  color: var(--azurite);
  cursor: pointer;
}
.add-row .ic { width: 22px; height: 22px; }

/* No lines yet: a lone boat on still water. */
.empty-lines { display: grid; justify-items: center; gap: 4px; padding: 14px 16px 2px; color: var(--muted); text-align: center; }
.empty-lines[hidden] { display: none; }
.boat { width: 220px; height: 90px; }
.boat .hull, .boat .figure { fill: var(--ink); opacity: 0.82; }
.boat .rod { fill: none; stroke: var(--ink); stroke-width: 1; opacity: 0.55; }
.boat .w { fill: none; stroke: var(--azurite); stroke-width: 1.2; stroke-linecap: round; opacity: 0.6; }

/* The scroll ends in a low range of hills behind the total. It sits inside
   the card's ruled frame, under the figures. */
.ground { position: absolute; left: 4px; right: 4px; bottom: 4px; height: 64px; overflow: hidden; border-radius: 0 0 2px 2px; opacity: 0.55; }
.ground .hills { height: 100%; }
.totals { position: relative; margin: 8px 0 0; padding: 0 var(--edge) 10px; }
.trow { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; }
.trow dt { display: flex; align-items: baseline; gap: 8px; color: var(--muted); min-width: 0; }
.trow dd { margin: 0; white-space: nowrap; }
/* A ledger's total: one rule above, and the hills below for the foot. */
.grand {
  margin: 6px 0 2px;
  padding: 4px 0;
  border-top: 1px solid var(--rule-strong);
  font-size: 19px;
  font-weight: 600;
}
.grand dt { color: var(--ink); }
.short dt, .short dd { color: var(--warn); font-weight: 600; }
/* A drifting cloud: nobody's yet. */
.short .cloud { width: 24px; height: 24px; }
.short dt { align-items: center; }

/* An amount being typed keeps its row's shape: the label on the left, its
   box ending on the receipt's right edge with every figure, and the actions
   on a row of their own below. The rows are set by hand, since auto-placement
   would push the tip's $/% toggle, which follows the box, down a row. */
.edit-form { display: grid; grid-template-columns: minmax(0, 1fr) auto 112px; align-items: center; gap: 8px; width: 100%; padding: 4px 0; }
.edit-form > label, .edit-form .seg, .edit-form .money-input { grid-row: 1; }
.edit-form > label { grid-column: 1; color: var(--muted); }
.edit-form .seg { grid-column: 2; }
.edit-form .money-input { grid-column: 3; }
.edit-form [data-cancel] { grid-row: 2; grid-column: 1; justify-self: start; }
.edit-form .go { grid-row: 2; grid-column: 2 / -1; justify-self: end; }
.edit-form .field-msg { grid-column: 1 / -1; }
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
/* No browser padding, so typed digits end exactly where the figures beside the field do. */
.money-input input { padding: 0; text-align: right; }
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
.line-form .actions { grid-column: 1 / -1; display: flex; gap: 8px; margin-top: 4px; }
.line-form .actions .go { margin-left: auto; }
.line-form .actions .chip-btn { min-width: 0; }
.line-form .field-msg { grid-column: 1 / -1; }
/* Editing a dish lays it out like the receipt: its own price, then one row
   per add-on, every price in one column flush with the name field's edge so
   the sum reads down to the total. An add-on's remove sits inside its name
   field, so it never pushes the prices off that edge. */
.dish-form > [name="label"] { grid-column: 1 / -1; }
.dish-form .money-input { grid-column: 2; }
.dish-form .field-label { grid-column: 1; align-self: center; color: var(--muted); }
.dish-form .addons-head { grid-column: 1 / -1; margin-top: 6px; color: var(--muted); font-size: 15px; }
.addon { display: contents; }
.addon-field { grid-column: 1; position: relative; display: flex; min-width: 0; }
.addon-field .text-input { padding-right: 44px; }
.addon-field .icon-btn { position: absolute; top: 0; right: 0; border-color: transparent; background: none; color: var(--muted); }
.dish-form .add-row { grid-column: 1 / -1; gap: 6px; font-size: 16px; }
/* A field's box edge is its amount's edge, as on the receipt, so the total
   ends where the price boxes do. */
.dish-sum { grid-column: 1 / -1; display: flex; justify-content: space-between; gap: 12px; margin-top: 2px; padding: 8px 0 2px; border-top: 1px solid var(--rule-strong); font-weight: 600; }
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
/* Room under the face for the badges that hang off its foot, clear of the name. */
.avw { position: relative; display: inline-block; margin-bottom: 8px; }
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
  box-shadow: 0 0 0 1px var(--rule-strong);
}
.badge .ic { width: 16px; height: 16px; }
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
/* Confirming presses the 定 seal down the same way. */
.slam .seal {
  position: relative;
  width: 132px;
  height: 132px;
  border-radius: 10px;
  font-size: 100px;
  box-shadow: inset 0 0 0 6px var(--seal), inset 0 0 0 10px rgba(251, 243, 234, 0.7);
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
.add-tile .av { background: none; border: 1.5px dashed var(--rule-strong); color: var(--azurite); box-shadow: none; }
.add-tile .av .ic { width: 22px; height: 22px; }
.add-tile .tile-name { color: var(--azurite); }
.guest-form-slot { grid-column: 1 / -1; }
.guest-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 0 4px; }
.guest-form .text-input { flex: 1; min-width: 0; }
.guest-form > .av { --s: 36px; }
.handle-form { display: flex; flex-wrap: wrap; gap: 8px; }
.handle-field { position: relative; flex: 1; min-width: 0; }
.handle-field .at { position: absolute; top: 0; left: 11px; color: var(--muted); line-height: 44px; pointer-events: none; }
.handle-field .text-input { width: 100%; padding-left: 28px; }
.handle-form .sheet-actions { flex-basis: 100%; margin-top: 4px; }

.bar {
  position: fixed;
  z-index: 10;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
  background: var(--card) var(--grain);
  border-top: 1px solid var(--rule-strong);
  box-shadow: 0 -6px 20px rgba(60, 40, 10, 0.06);
}
/* One footer for everyone, the payer too: what you owe and, when you brought
   guests, what each of them owes. With guests each amount is also the switch
   for whose dishes a tap claims. Its width matches the page's, so the first
   amount starts on the card's edge; the padding gives a focused amount's ring
   room inside the scroller, which would clip it, and the margin takes it back. */
.owes {
  display: flex;
  gap: 8px;
  max-width: 456px;
  margin: -4px max(-4px, calc((100% - 448px) / 2 - 4px));
  padding: 4px;
  overflow-x: auto;
  scrollbar-width: none;
}
.owes::-webkit-scrollbar { display: none; }
/* Two share the width at phone size; a third scrolls rather than squeezing a
   name to nothing. Each amount is a paper slip with a mineral tab: azurite
   for you, ochre for a guest. */
.owe {
  --tab: var(--azurite);
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 0 0;
  min-width: 152px;
  min-height: 58px;
  padding: 6px 12px 6px 8px;
  border: 1.5px solid var(--rule);
  border-top: 4px solid var(--tab);
  border-radius: 3px 3px 6px 6px;
  background: none;
  text-align: left;
}
.owe.is-guest { --tab: var(--warn); }
button.owe { cursor: pointer; }
button.owe[aria-pressed="true"] { border-color: var(--ink); border-top-color: var(--tab); background: var(--fill); }
/* The margin keeps the mark on the avatar's shoulder clear of the label beside it. */
.owe-av { position: relative; display: inline-grid; flex: none; margin-right: 6px; }
.owe .av { --s: 36px; }
/* The slip whose dishes a tap claims carries the claim's moss dot, on the
   face's shoulder so it stays inside the slip. */
.owe .mark { position: absolute; top: -5px; right: -7px; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--moss); color: var(--card); box-shadow: 0 0 0 1.5px var(--card); }
.owe .mark .ic { width: 13px; height: 13px; }
button.owe[aria-pressed="false"] .mark { display: none; }
/* The amount ends on the card's right edge like every other figure: beside
   the label when the card is wide enough, under it when not. */
.owe-text { display: flex; flex: 1; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 3px 8px; min-width: 0; }
.owe-label { font-size: 15px; line-height: 1.2; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.owe .amount { margin-left: auto; font: 500 26px/1 var(--display); letter-spacing: -0.01em; white-space: nowrap; }

.view + .view { margin-top: 18px; }
.is-live[data-layout="share"] .view:not(.is-active) { display: none; }
.is-live[data-layout="share"] .view + .view { margin-top: 0; }
.hero { position: relative; padding: 18px var(--edge) 16px; overflow: hidden; }
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
/* Name over amount, so four parts with a discount still fit one line at
   phone width and keep fitting as the amounts grow. */
.legend.parts { gap: 4px 28px; }
.legend.parts > span { flex-direction: column; align-items: flex-start; gap: 1px; }
.part-name { display: inline-flex; align-items: center; gap: 5px; height: 18px; font-size: 14px; }
.legend.parts .money { color: var(--ink); }
/* Venmo can't tell us a payment happened, so I paid stays beside the way out
   to it, and has the row to itself when there is no Venmo to go to. */
.pay-acts { display: flex; gap: 8px; margin-top: 16px; }
.pay-acts > * { flex: 1 1 0; min-width: 0; }
.pay-row { display: flex; }
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
/* The device picks the link. A custom scheme goes nowhere on a computer, and
   this works where a user agent wouldn't: an iPad reports itself as a Mac. */
.pay.is-app { display: none; }
@media (pointer: coarse) {
  .pay.is-app { display: flex; }
  .pay.is-web { display: none; }
}
/* Whose shares one amount covers, when it covers guests too. */
.whose { list-style: none; margin: 12px 0 0; padding: 0; }
.whose li { display: flex; align-items: center; gap: 10px; min-height: 40px; border-top: 1px solid var(--rule); }
.whose .av { --s: 28px; }
.whose .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.whose .note { flex: 1; color: var(--muted); font-size: 15px; white-space: nowrap; }
.whose .is-off { color: var(--muted); }
.hero .whose .stamp { position: static; font-size: 12px; padding: 2px 1px; border-width: 1.5px; letter-spacing: 1px; }
/* Recording a payment is the person's own word, not a link out, so it is
   inked rather than sealed. */
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

.mine { margin-top: 12px; padding: 4px var(--edge); }
.mine ul { list-style: none; margin: 0; padding: 0; }
.mine li { display: flex; align-items: center; gap: 10px; min-height: 44px; padding-block: 8px; border-bottom: 1px solid var(--rule); }
.mine li:last-child { border-bottom: 0; }
/* A wrapped dish keeps its amount level with the middle of the name, as a
   one-line dish does, instead of the name hugging the rule above. */
.mine li .item-label, .sheet-lines .item-label { flex: 1; align-self: auto; line-height: 1.35; }
.mine .piece { color: var(--muted); }
.mine .tax-tip, .sheet-lines .tax-tip { color: var(--muted); }
/* A guest's lines hang off their name under a dashed rule, the same dash as a
   guest's avatar, so it is plain which lines are theirs. */
.mine-group { border-top: 1px solid var(--rule); }
.mine > .mine-group:first-child { border-top: 0; }
.mine-guest { display: flex; align-items: center; gap: 8px; padding: 12px 0 2px; color: var(--muted); font-size: 15px; }
.mine-guest .av { --s: 24px; }
.mine-group ul { margin: 0 0 8px 11px; padding-left: 21px; border-left: 1.5px dashed var(--azurite); }

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
.confirm-area { padding: 12px 8px; border-bottom: 1px solid var(--rule); }
.confirm-area:last-child { border-bottom: 0; }
/* Confirm is a seal you press: the 定 seal and the word, with what still
   stands in the way under it. */
.confirm-btn {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: 16px;
  width: 100%;
  min-height: 72px;
  padding: 2px 4px;
  border: 0;
  border-radius: 8px;
  background: none;
  text-align: left;
  cursor: pointer;
}
.confirm-btn .seal { width: 64px; height: 64px; font-size: 46px; border-radius: 6px; box-shadow: inset 0 0 0 3px var(--seal), inset 0 0 0 5px rgba(251, 243, 234, 0.7); }
.confirm-text { min-width: 0; }
.confirm-word { display: block; font-size: 18px; font-weight: 600; }
.confirm-btn:active .seal { transform: rotate(-6deg) scale(0.96); }
.confirm-btn:disabled { cursor: default; }
.confirm-btn:disabled .seal { background: var(--fill); color: var(--ring); box-shadow: inset 0 0 0 1.5px var(--ring); }
.confirm-btn:disabled .confirm-word { color: var(--muted); }
.confirm-btn[aria-busy="true"] { cursor: progress; opacity: 0.75; }
.confirm-btn.l-confirm { display: flex; flex-direction: column; gap: 6px; padding: 16px 8px 4px; text-align: center; }
.confirm-btn.l-confirm .seal { border-radius: 5px; box-shadow: inset 0 0 0 2px var(--seal), inset 0 0 0 3.5px rgba(251, 243, 234, 0.7); }
.confirm-btn.l-confirm:disabled .seal { box-shadow: none; }
.l-acts { padding: 0 6px; }
.l-why { color: var(--muted); font-size: 15px; font-weight: 400; text-align: center; }
.l-why.warn { color: var(--warn); font-weight: 600; }
.l-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 9px 9px 13px; border-bottom: 1px solid var(--rule); color: var(--muted); font-size: 15px; font-weight: 600; }
.l-chip { display: inline-flex; align-items: center; min-height: 34px; padding: 0 12px; border: 1px solid var(--rule-strong); border-radius: 17px; background: var(--card); color: var(--ink); font-size: 15px; font-weight: 400; white-space: nowrap; cursor: pointer; }
.l-chip.is-on { background: var(--ink); border-color: var(--ink); color: var(--card); }
.l-ask { margin-bottom: 12px; padding: 12px 13px 13px; }
.l-ask label { display: block; font-size: 16px; font-weight: 600; line-height: 1.35; }
.l-entry { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
.l-entry input { flex: 1; min-width: 0; min-height: 44px; padding: 0 12px; border: 1.5px solid var(--azurite); border-radius: var(--radius); background: var(--paper); color: var(--ink); font: inherit; font-size: 17px; }
[data-layout="log"] .receipt { padding-bottom: 0; }
[data-layout="log"] .totals { margin: 0; padding: 4px var(--edge) 8px; border-top: 1px solid var(--rule-strong); }
[data-layout="log"] .trow { min-height: 34px; }
[data-layout="log"] .grand { min-height: 40px; margin: 0; padding: 0; border-top: 0; font-size: 18px; }
[data-layout="log"] .item:last-child { border-bottom: 0; }
.l-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 58px; font-size: 16px; }
.l-bar .money { font-size: 20px; font-weight: 600; }
.l-bar .l-none { color: var(--muted); }
.l-name { display: inline; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.l-act { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 50px; padding: 0 13px; border: 0; border-bottom: 1px solid var(--rule); border-radius: 0; background: none; color: var(--ink); font: inherit; font-size: 16px; text-align: left; cursor: pointer; }
.l-act:last-child { border-bottom: 0; }
.l-act .ic { width: 16px; height: 16px; color: var(--muted); }
.l-act.dan { color: var(--seal); }
.l-act.is-armed { border-radius: 8px; background: var(--ink); color: var(--card); }
.l-act[aria-busy="true"] { cursor: progress; opacity: 0.75; }
.l-discard { justify-content: center; margin-top: 8px; border-bottom: 0; }
.l-note { display: flex; gap: 9px; margin-top: 12px; padding: 10px 13px; border: 1px solid var(--rule-strong); border-radius: var(--radius); background: var(--card) var(--grain); font-size: 15px; line-height: 1.35; }
.hero .l-sub { margin-top: 3px; color: var(--muted); font-size: 16px; }
.mine .card-h { display: flex; align-items: center; gap: 7px; padding: 9px 0 2px; color: var(--muted); font-size: 15px; font-weight: 600; }
.mine .card-h .ic { width: 17px; height: 17px; }
.is-log-gone [data-log-part], .is-log-gone [data-log-ask] { display: none; }
/* The receipt's own total, here only while it is what stops the bill being
   confirmed: missing, or not what the lines add up to. */
.confirm-area .trow { margin: -4px 0 10px; padding: 0 2px; }
.confirm-area .trow dt { color: var(--ink); }
.why { display: block; margin-top: 2px; color: var(--warn); font-size: 15px; font-weight: 600; }
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

/* A delete waits for its second tap in solid ink, calm rather than alarmed.
   The fill sits inset on its own layer, so it stays off the page's ruled
   frame without the row changing size when it arms. */
.act.is-armed { position: relative; isolation: isolate; }
.act.is-armed::before { content: ""; position: absolute; inset: 5px 0; z-index: -1; border-radius: 8px; background: var(--ink); }
.act.is-armed, .act.is-armed .ic { color: var(--card); }
.act[aria-busy="true"] { cursor: progress; opacity: 0.6; }

.payments { margin-top: 12px; padding: 0 var(--edge) 4px; }
.payments h2 { padding: 14px 0 2px; color: var(--muted); font-size: 15px; font-weight: 600; }
.payments ul { list-style: none; margin: 0; padding: 0; }
.payments li { display: flex; align-items: center; gap: 8px; min-height: 56px; border-bottom: 1px solid var(--rule); }
.payments li:last-child { border-bottom: 0; }
.payments .av { --s: 30px; }
.payments .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.payments .chip-btn { flex: none; justify-content: center; width: 96px; padding: 0 8px; font-size: 15px; }

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
  background: var(--card) var(--grain);
  color: var(--ink);
  /* The sheet rises with a ridge for its top edge. A mask cuts the shape, so a
     shadow would only outline the box it was cut from. */
  -webkit-mask: var(--ridge) top / 100% 34px no-repeat, linear-gradient(#000, #000) 0 33px / 100% calc(100% - 33px) no-repeat;
  mask: var(--ridge) top / 100% 34px no-repeat, linear-gradient(#000, #000) 0 33px / 100% calc(100% - 33px) no-repeat;
}
/* A pseudo-element, so the client's redraws of the sheet's contents leave the wash alone. */
dialog.sheet::before { content: ""; position: absolute; inset: 0 0 auto; height: 90px; background: var(--sheet-wash) top / 100% 100% no-repeat; pointer-events: none; }
dialog.sheet::backdrop { background: var(--scrim); }
/* Close sits under the ridge, above the head, so a head's amount can end on
   the right edge like every other figure in the sheet. */
.sheet-in { position: relative; padding: 70px 18px 20px; }
.sheet .close { position: absolute; top: 26px; right: 6px; border: 0; background: none; }
.sheet-head { display: flex; align-items: center; gap: 12px; min-height: 52px; }
.sheet-head .av { --s: 44px; }
.sheet-head h2 { flex: 1; min-width: 0; font-size: 20px; font-weight: 600; overflow-wrap: anywhere; }
/* A dish is item text, not a name, so its title stays in the book face. */
.sheet-head h2.dish-title { line-height: 1.25; word-break: keep-all; }
.sheet-head .money { font: 500 24px/1 var(--display); }
.sheet .legend { margin: 0 0 6px; }
/* No bar in the sheet for a key to point at. */
.sheet .legend .key { display: none; }
.sheet ul { list-style: none; margin: 0; padding: 0; }
.sheet-lines li { display: flex; align-items: center; gap: 10px; min-height: 42px; padding-block: 8px; border-bottom: 1px solid var(--rule); }
.sheet-lines li:last-child { border-bottom: 0; }
.sheet-lines .item-label { font-size: 16px; }
.sheet-lines .empty { color: var(--muted); }
.sheet-guest { margin-top: 14px; padding-top: 18px; background: var(--ripple) top / 100% 14px no-repeat; }
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
.chip-btn.is-armed { background: var(--ink); border-color: var(--ink); color: var(--card); }
.chip-btn.go { background: var(--ink); border-color: var(--ink); color: var(--card); }
.chip-btn:disabled { opacity: 0.45; cursor: default; }
/* The target's name rides in the button, clipped rather than wrapped so the
   button keeps one line. */
.chip-btn .target { min-width: 0; max-width: 11em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* While a delete waits for its second tap, the name of what it would remove
   is struck through with a brush, so there is no doubt which thing goes. The
   stroke is a background so it follows a wrapped name onto every line. */
.is-struck .struck {
  color: var(--muted);
  background: var(--strike) 0 58% / 100% 0.5em no-repeat;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
.chip-btn[aria-busy="true"] { cursor: progress; }
.sheet-body { margin: 0 0 10px; color: var(--muted); }
.sheet-go { flex: 1; justify-content: center; min-height: 50px; border-radius: 25px; }
.sheet-go.is-seal { background: var(--seal); border-color: var(--seal); color: var(--seal-ink); }
.sheet-go.is-ink { background: var(--ink); border-color: var(--ink); color: var(--card); }
.sheet-msg { margin-top: 8px; color: var(--warn); font-size: 15px; }
.sheet-msg:empty { display: none; }
.picker { display: grid; grid-template-columns: repeat(auto-fill, minmax(60px, 1fr)); gap: 4px; margin: 4px 0 8px; }
/* No amount under a name here, so no room kept for one. */
.pick { position: relative; min-height: 0; }
/* Only the people who had it carry the moss check, on the face's shoulder
   and inside its box, the same mark as the footer's. An empty ring on every
   other face read as stray blobs. */
.pick .tick { position: absolute; right: 0; top: 0; width: 20px; height: 20px; border: 0; background: var(--moss); box-shadow: 0 0 0 1.5px var(--card); }
.pick .tick .ic { width: 14px; height: 14px; opacity: 1; }
.pick[aria-pressed="false"] .tick { display: none; }
.pick .tile-name { font-size: 14px; }
.sheet .line-form { padding: 6px 0 4px; }

.notice { margin-top: 18vh; padding: 22px 20px; text-align: center; }
.notice h1 { font-size: 23px; line-height: 1.25; }
.notice p { color: var(--muted); margin-top: 10px; }

@media (prefers-reduced-motion: reduce) {
  .is-inked .tick, .is-pressed { animation: none; }
  .slam .stamp, .slam .seal { animation-name: slam-fade; }
  .slam .stamp::after { animation: none; }
}
@media (min-width: 700px) {
  .page { --page-top: 40px; }
}
/* Past phone width the page is a column on a wider sheet, so the range fades
   out at its sides rather than ending on a cut. */
@media (min-width: 500px) {
  .head > .hills { -webkit-mask: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent); mask: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent); }
}
`;

// One brush-weight stroke set, referenced by <use> from the page and the
// script alike, so neither repeats path data. The marks a hand makes most
// (check, plus, close) are filled brush strokes that swell and taper, not
// ruled lines.
const ICONS: Record<string, string> = {
  check: '<path fill="currentColor" stroke="none" d="M3.6 12.9c.7-.9 1.9-1 2.8-.3l3.3 2.7c2.4-3.9 5.5-7.4 9.6-10.3.4-.3.9.2.6.6-3.5 3.7-6.3 8-8.4 12.6-.4.9-1.6 1.1-2.3.4l-5.4-4.4c-.5-.4-.6-1-.2-1.3z"/>',
  plus: '<path fill="currentColor" stroke="none" d="M4 12.3c-.2-.9.4-1.5 1.3-1.4l13.4.3c1.1 0 1.6.5 1.5 1.2-.1.6-.7.9-1.4.9L5.4 13.5c-.8 0-1.3-.4-1.4-1.2zM11.4 4.4c.3-.7 1.6-.8 1.8.1l-.2 14.4c0 .9-.3 1.4-.7 1.4s-.7-.5-.8-1.2L11.2 5.2c0-.3.1-.6.2-.8z"/>',
  arrow: '<path d="M4 12h15M14 6.5l5.5 5.5-5.5 5.5"/>',
  out: '<path d="M7 17L17 7M9 7h8v8"/>',
  chev: '<path d="M9.5 6l6 6-6 6"/>',
  back: '<path d="M14.5 6l-6 6 6 6"/>',
  close: '<path fill="currentColor" stroke="none" d="M5.6 6.5c.2-.8 1.1-1.1 1.8-.5l11 10.6c.7.7.8 1.4.3 1.8-.5.4-1.1.2-1.6-.3L6 7.9c-.4-.4-.5-.9-.4-1.4zM17.6 5.4c.5-.3 1.2.1 1 .7-.2.5-.5.9-.9 1.3L7.4 18.1c-.5.5-1.2.6-1.5.2-.3-.4-.2-1 .3-1.5L17 5.9c.2-.2.4-.4.6-.5z"/>',
  // A cash coin: the square hole and the four characters' places round it.
  coin: '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="6.6" stroke-width="1"/><path d="M9.7 9.7h4.6v4.6H9.7z"/><path stroke-width="1.4" d="M12 6.4v1.3M12 16.3v1.3M6.4 12h1.3M16.3 12h1.3"/>',
  gift: '<path d="M4.5 11h15v9h-15zM3.5 7.5h17V11h-17zM12 7.5V20M12 7.5C10.5 4 7 4 7.5 6.3 8 7.5 12 7.5 12 7.5zM12 7.5c1.5-3.5 5-3.5 4.5-1.2C16 7.5 12 7.5 12 7.5z"/>',
  receipt: '<path d="M6 3.5h12v17l-2.5-1.6-2.5 1.6-2.5-1.6-2.5 1.6-2.5-1.6zM9 8.5h6M9 12h6M9 15.5h3"/>',
  people: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5"/><circle cx="16.5" cy="9.5" r="2.6"/><path d="M15.5 14.2c2.6-.3 4.4 1.3 5 4.3"/>',
  bowl: '<path d="M3.5 11.5h17a8.5 8.5 0 0 1-17 0zM9 8c-.8-1.4.8-2.2 0-3.8M13 8c-.8-1.4.8-2.2 0-3.8"/>',
  dish: '<path d="M3.5 13.5h17a8.5 6.5 0 0 1-17 0z"/><path d="M7 10.5L19.5 4M9.5 11L20.5 6.5"/>',
  pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.2"/>',
  // A woven basket with a crumpled sheet in it: what you throw away.
  basket: '<path d="M5 11h14l-1.8 9.4H6.8z"/><path d="M6 15.4h12M10.2 11.4l.4 8.6M13.8 11.4l-.4 8.6"/><path d="M8.9 10.6l-.6-3.1 2.2-2.6 3.1-.3 2.4 2-.3 3.1M10.5 4.9l1.4 3.2 4.2-1.1M11.9 8.1l-.5 2.5"/>',
  cloud: '<path d="M5.6 17.6C3.8 17.6 2.6 16.3 2.6 14.8c0-1.7 1.5-3 3.2-2.8.3-2.7 2.5-4.6 5.2-4.6 2.3 0 4.2 1.4 4.9 3.4 2.4-.4 4.6 1.3 4.6 3.6 0 1.8-1.3 3.2-3.1 3.2z"/><path d="M8.6 14.6c-.2-1.4 1.3-2.4 2.5-1.6 1 .6.9 2.1-.2 2.4"/><path d="M15.4 14.2c.4-1 1.8-1.1 2.3-.2"/>',
  warn: '<path d="M12 4.5l8.5 15h-17zM12 10.5v4M12 17.3v.2"/>',
  // A calligraphy brush, hung by its loop, with the stroke it just laid down.
  brush: '<circle cx="20.3" cy="3.7" r="1.2"/><path d="M19.4 4.6l-6 6"/><path stroke-width="3" stroke-linecap="butt" d="M13.9 10.1l-1.8 1.8"/>' +
    '<path fill="currentColor" stroke="none" d="M11.6 11.6c-2.6.1-5.1 4.2-6.7 8.3 4.1-1.6 8.2-4.1 8.3-6.7z"/><path fill="currentColor" stroke="none" d="M3 21.4c3-1 6.4-1.3 10-.9.4.1.4.5 0 .5-3.4 0-6.6.4-9.7 1-.5.1-.7-.4-.3-.6z"/>',
};

export function sprite(): string {
  const symbols = Object.entries(ICONS)
    .map(([name, paths]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${paths}</symbol>`)
    .join("");
  return `<svg class="sprite" aria-hidden="true" focusable="false">${HILL_DEFS}${symbols}</svg>`;
}

// The hills fade to nothing at their feet and their edges wobble like a wash
// that bled into the paper. Defined once in the sprite and shared by every range.
const HILL_DEFS =
  '<defs><linearGradient id="g-fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="#000"/></linearGradient>' +
  '<mask id="m-fade" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="url(#g-fade)"/></mask>' +
  '<filter id="f-rough" x="-2%" y="-10%" width="104%" height="120%"><feTurbulence type="fractalNoise" baseFrequency=".035 .08" numOctaves="2" seed="4" result="n"/>' +
  '<feDisplacementMap in="SourceGraphic" in2="n" scale="5"/></filter></defs>';

const FAR_HILLS = "M0 70C30 52 52 30 78 38C98 44 108 22 132 18C156 14 170 40 196 46C222 52 240 28 262 30C290 32 300 54 330 50C352 47 370 36 390 40V120H0Z";
const MID_HILLS = "M0 88C24 80 40 62 66 66C90 70 104 84 130 78C152 73 168 56 192 60C214 64 226 82 252 84C280 86 296 64 322 66C350 68 368 82 390 80V120H0Z";

// The viewBox trims the ends of the paths, where the displacement would
// otherwise pull the wash in from the sides.
export function hills(moon: boolean): string {
  return `<div class="hills" aria-hidden="true">${moon ? '<span class="moon"></span>' : ""}<svg viewBox="5 0 380 120" preserveAspectRatio="none">` +
    `<path class="far" d="${FAR_HILLS}" mask="url(#m-fade)" filter="url(#f-rough)"/><path class="mid" d="${MID_HILLS}" mask="url(#m-fade)" filter="url(#f-rough)"/></svg></div>`;
}

export function icon(name: string, extra = ""): string {
  return `<svg class="ic${extra ? ` ${extra}` : ""}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
}

const BRUSH = icon("brush", "brush");

export function shell(title: string, body: string, styles = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#efe7d6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#111417" media="(prefers-color-scheme: dark)">
<title>${escapeHtml(title)}</title>
<style>${STYLES}${styles}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// Notices carry only fixed text, never anything from a bill, so a refused
// visitor learns nothing about what the link pointed at.
export function notice(heading: string, paragraph: string): string {
  return shell(
    `${heading} · AAzhi`,
    `<main class="page"><div class="card notice"><h1>${heading}</h1><p>${paragraph}</p></div></main>`,
  );
}

export function renderLinkRefused(): string {
  return notice(
    "This link has expired",
    "Links last 30 minutes and only work for the person they were made for. " +
      "For a split, tap <strong>Open the split</strong> on the bill in Discord. " +
      "For a log, run <strong>/log</strong> again, or use <strong>/profile</strong> for one you already logged.",
  );
}

export function renderBillNotFound(): string {
  return notice(
    "There's no split here",
    "This bill doesn't exist any more. Go back to Discord and tap <strong>Open the split</strong> on the latest bill message, " +
      "or run <strong>/log</strong> for a receipt of your own.",
  );
}

export function renderBillGone(bill: Pick<BillRow, "status" | "kind">): string {
  if (bill.kind === "log") {
    return notice("This log was removed", "It no longer counts. If you undid it, you can run <strong>/log</strong> again inside the 8 hours.");
  }
  return bill.status === "superseded"
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
export function hueOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.codePointAt(0)!) % 1_000_003;
  return h % 8;
}

export function initialOf(name: string): string {
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
  const mark =
    status === "confirmed"
      ? '<span class="seal" aria-hidden="true">定</span>'
      : status === "draft"
        ? '<span class="seal is-draft" aria-hidden="true">稿</span>'
        : '<span class="seal-slot" aria-hidden="true"></span>';
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

function logWord(s: BillState): string {
  return s.status === "confirmed" ? "Logged" : "Your items";
}

// Mirrors renderHeader in the client. A draft's name can be fixed right on it.
function logHeader(v: View): string {
  const s = v.s;
  const name = escapeHtml(s.place?.trim() || "Receipt");
  const seal = `<span class="seal${s.status === "confirmed" ? "" : " is-draft"}" aria-hidden="true">记</span>`;
  return `<header class="head">
${hills(true)}
<h1 data-log-name>${s.editable === "self" && s.place?.trim() ? `<button type="button" class="l-name" data-fix-name>${name}${BRUSH}</button>` : name}</h1>
<p class="status" data-status-label>${seal}<span class="word">${logWord(s)}</span></p>
<p class="meta">${s.stamp ? `<span>${escapeHtml(s.stamp)}</span>` : ""}</p>
</header>
<p class="toast" data-live-note role="status" hidden></p>`;
}

function header(v: View): string {
  if (v.s.kind === "log") return logHeader(v);
  const date = shortDate(v.bill.billDate, v.year);
  return `<header class="head">
${hills(true)}
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
<p>${draft ? "If you were there, tap <strong>Open the split</strong> on the bill in Discord to join it." : "Nothing here is yours to pay."}</p>
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

// Each add-on on its own line under the dish, its price under the dish's. The
// price is plain even for the payer: the dish's brush already opens the editor
// with every add-on in it.
function addonLines(addons: Addon[]): string {
  return addons
    .map((a) => {
      const price = a.cents === 0 ? "" : `<span class="addon-price">${a.cents > 0 ? "+" : ""}${formatCents(a.cents)}</span>`;
      return `<span class="addon-line"><span class="addon-name">${escapeHtml(a.label)}</span>${price}</span>`;
    })
    .join("");
}

// Three shapes: the payer can tap the tick (their own claim) apart from the
// rest of the line (who had it, and fixing it); a member taps the whole line
// for their own claim; anyone else sees it locked.
function itemRow(v: View, item: LineItem): string {
  const mine = item.claimedBy.includes(v.s.viewer);
  // On a log a line left unticked is just something you didn't have.
  const unclaimed = item.claimedBy.length === 0 && v.s.kind !== "log";
  const others = item.claimedBy.filter((id) => id !== v.s.viewer);
  const brush = v.s.editable === "all" ? BRUSH : "";
  const inner =
    `<span class="item-label">${escapeHtml(item.label)}</span><span class="item-price">${brush}${formatCents(item.cents)}</span>` +
    (item.addons ? `<span class="item-addons">${addonLines(item.addons)}</span>` : "") +
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

// The payer's editable amounts are their own buttons, so the row reads as
// plain figures to everyone else and as figures to fix to the one who paid.
function amount(v: View, field: string, key: string, cents: Cents | null, label: string): string {
  const shown = `<span data-total="${key}">${cents === null ? "—" : formatCents(cents)}</span>`;
  if (v.s.editable !== "all") return shown;
  return `<button type="button" class="amt" data-edit-field="${field}" aria-label="${label}, ${cents === null ? "not entered" : formatCents(cents)}">${BRUSH}${shown}</button>`;
}

// The receipt as printed, with nothing here to change.
function logTotals(s: BillState): string {
  const r = s.result;
  const row = (label: string, key: string, cents: Cents, cls = "") =>
    `<div class="trow${cls}"><dt>${label}</dt><dd data-total="${key}">${formatCents(cents)}</dd></div>`;
  return `<dl class="totals" data-totals>${row("Subtotal", "subtotal", r.billSubtotalCents)}${s.discountCents !== 0 ? row("Discount", "discount", -s.discountCents) : ""}` +
    `${row("Tax", "tax", s.taxCents)}${row("Receipt total", "total", s.printedTotalCents ?? r.distributableCents, " grand")}</dl>`;
}

function totals(v: View): string {
  const s = v.s;
  if (s.kind === "log") return logTotals(s);
  const r = s.result;
  const rows = [
    `<div class="trow"><dt>Subtotal</dt><dd data-total="subtotal">${formatCents(r.billSubtotalCents)}</dd></div>`,
  ];
  // The payer sees it at $0.00 too, since that row is where they add one.
  if (s.discountCents !== 0 || s.editable === "all") {
    rows.push(`<div class="trow" data-field-row="discount"><dt>${withPercent("Discount", s.discountCents, r.billSubtotalCents)}</dt><dd>${amount(v, "discount", "discount", -s.discountCents, "Discount")}</dd></div>`);
  }
  rows.push(
    // Tax is charged on what's left after the discount, so that is the base
    // a diner would check their local rate against.
    `<div class="trow" data-field-row="tax"><dt>${withPercent("Tax", s.taxCents, r.billSubtotalCents - s.discountCents)}</dt><dd>${amount(v, "tax", "tax", s.taxCents, "Tax")}</dd></div>`,
  );
  rows.push(
    `<div class="trow" data-field-row="tip"><dt>${withPercent("Tip", s.tipCents, r.billSubtotalCents)}</dt><dd>${amount(v, "tip", "tip", s.tipCents, "Tip")}</dd></div>`,
    `<div class="trow grand"><dt>Total</dt><dd data-total="total">${formatCents(r.distributableCents)}</dd></div>`,
  );
  if (r.unclaimedCents !== 0) {
    rows.push(
      `<div class="trow short"><dt>${icon("cloud", "cloud")}Unclaimed</dt><dd data-total="unclaimed">${formatCents(r.unclaimedCents)}</dd></div>`,
    );
  }
  return `<dl class="totals" data-totals>${rows.join("")}</dl>`;
}

export const BOAT =
  '<svg class="boat" viewBox="0 0 220 90" aria-hidden="true" focusable="false">' +
  '<path class="hull" d="M70 56c20 5 60 5 84-1 2-.5 3 1 1.6 2.4-6 6-20 9.5-42 9.5-21 0-35-3.6-45-8.6-1.4-.7-.6-2.7 1.4-2.3z"/>' +
  '<path class="figure" d="M98 41.5l9-4.2 9 4.2zM102 42.5c.4 4-.2 8.6-1.8 12.5h12.2c-1.4-3.9-2-8.5-1.6-12.5z"/>' +
  '<path class="rod" d="M112 46l44-20M156 26l2 44"/><path class="w" d="M40 72h44M130 74h50M70 80h30M150 82h26M20 64h26"/></svg>';

function receipt(v: View): string {
  const list = v.s.items.length > 0 ? `<ul class="items">${v.s.items.map((i) => itemRow(v, i)).join("\n")}</ul>` : "";
  const add =
    v.s.editable === "all"
      ? `<div class="add-line needs-js" data-add-line><button type="button" class="add-row" data-add-open aria-label="Add a line">${icon("plus")}</button></div>`
      : "";
  const empty = `<div class="empty-lines" data-empty-lines${v.s.items.length > 0 ? " hidden" : ""}>${BOAT}<p>No lines yet.</p></div>`;
  return `<section class="card receipt${v.s.editable === "all" ? " is-editable" : ""}" data-items aria-label="Receipt">
${list}
${empty}
${add}
<div class="ground">${hills(false)}</div>
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

// You first, then the guests you brought, each with what they owe: the same
// footer for everyone, the payer included. With guests, each amount is also
// the switch for whose dishes a tap claims, so the pressed one says whose
// lines these are.
function owes(v: View): string {
  const ids = [v.s.viewer, ...guestsOf(v, v.s.viewer).map((g) => g.id)];
  const pick = v.s.editable !== "none" && ids.length > 1;
  const entries = ids.map((id) => {
    const label = id === v.s.viewer ? "You owe" : `${nameOf(v, id)} owes`;
    const mark = pick ? `<span class="mark" aria-hidden="true">${icon("check")}</span>` : "";
    const inner = `<span class="owe-av">${av(v, id)}${mark}</span><span class="owe-text"><span class="owe-label">${escapeHtml(label)}</span>` +
      `<span class="amount money"${id === v.s.viewer ? " data-you-owed" : ""}>${formatCents(v.shares.get(id)?.owedCents ?? 0)}</span></span>`;
    const cls = id === v.s.viewer ? "owe" : "owe is-guest";
    return pick
      ? `<button type="button" class="${cls}" data-claim-as="${escapeHtml(id)}" aria-pressed="${id === v.s.viewer}">${inner}</button>`
      : `<div class="${cls}">${inner}</div>`;
  });
  return `<div class="owes" data-owes${pick ? ' role="group" aria-label="Claim for"' : ""}>${entries.join("")}</div>`;
}

function bar(v: View): string {
  if (!v.onBill) return "";
  return `<div class="bar" data-bar>${owes(v)}</div>`;
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

interface Parts {
  food: Cents;
  discount: Cents;
  tax: Cents;
  tip: Cents;
}

function splitParts(shares: Share[]): Parts {
  return shares.reduce(
    (n, x) => ({ food: n.food + x.subtotalCents, discount: n.discount + x.discountCents, tax: n.tax + x.taxCents, tip: n.tip + x.tipCents }),
    { food: 0, discount: 0, tax: 0, tip: 0 },
  );
}

// The bar draws what is paid, so the discount comes out of the food it was
// taken off rather than getting a segment of its own.
function splitBar(parts: Parts): string {
  const seg = (cls: string, cents: Cents) => (cents > 0 ? `<span class="${cls}" style="flex:${cents}"></span>` : "");
  const off = parts.discount !== 0;
  const label = `Food ${formatCents(parts.food)}, ${off ? `Discount ${formatCents(-parts.discount)}, ` : ""}Tax ${formatCents(parts.tax)}, Tip ${formatCents(parts.tip)}`;
  return `<div class="split-bar" role="img" aria-label="${label}">${seg("food", parts.food - parts.discount)}${seg("tax", parts.tax)}${seg("tip", parts.tip)}</div>
<p class="legend parts" data-you-detail><span><span class="part-name"><span class="key food" aria-hidden="true"></span>${icon("bowl")}<span class="sr">Food</span></span><span class="money">${formatCents(parts.food)}</span></span>` +
    (off ? `<span><span class="part-name">Discount </span><span class="money">${formatCents(-parts.discount)}</span></span>` : "") +
    `<span><span class="part-name"><span class="key tax" aria-hidden="true"></span>Tax </span><span class="money">${formatCents(parts.tax)}</span></span>` +
    `<span><span class="part-name"><span class="key tip" aria-hidden="true"></span>Tip </span><span class="money">${formatCents(parts.tip)}</span></span></p>`;
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
  const pay = v.s.pay;
  if (!pay) return "";
  const link = (kind: string, url: string) => `<a class="pay ${kind}" href="${escapeHtml(url)}">Venmo${icon("out")}</a>`;
  return `<div class="pay-row" data-pay>${link("is-app", pay.appUrl)}${link("is-web", pay.webUrl)}</div>`;
}

function payActs(pay: string, sent: string): string {
  return pay || sent ? `<div class="pay-acts">${pay}${sent}</div>` : "";
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
${payActs(paid ? "" : payRow(v), sentRow(v))}
</section>`;
}

// Discount, tax and tip are the share's own, from the split, so the lines add
// up to that person's amount to the cent.
function taxTipRows(v: View, id: ParticipantId): string {
  const share = v.shares.get(id);
  if (!share) return "";
  const row = (label: string, cents: Cents) => `<li class="tax-tip"><span class="item-label">${label}</span><span class="money">${formatCents(cents)}</span></li>`;
  return (share.discountCents !== 0 ? row("Discount", -share.discountCents) : "") + row("Tax", share.taxCents) + row("Tip", share.tipCents);
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
  if (s.receiptTaken) return "This receipt was already split.";
  if (s.printedTotalCents === null) return "Enter the receipt total first.";
  if (!s.reconciles.ok) return "Line items do not add up to total!";
  if (!s.items.some((i) => i.claimedBy.length > 0)) return "Nobody has claimed anything yet.";
  if (!s.hasSplitPartner) {
    const joined = s.participants.some((p) => p.kind === "member" && p.id !== s.payerId);
    return joined ? "Someone else needs to claim an item." : "Add someone, or use /log.";
  }
  return null;
}

function logSpent(s: BillState): Cents {
  return s.result.shares.find((x) => x.participant === s.viewer)?.owedCents ?? 0;
}

// Why Log it won't go yet, or null. The server refuses the same cases. Mirrored
// in the client.
function logBlock(s: BillState): string | null {
  if (s.receiptSplit) return "This receipt was already split.";
  if (s.receiptTaken) return "This receipt was already logged.";
  if (!s.place?.trim()) return "Add the name of this place.";
  const spent = logSpent(s);
  if (spent <= 0) return "Pick what you had.";
  return s.printedTotalCents !== null && spent > s.printedTotalCents ? "Your items add up to more than the receipt's total." : null;
}

// A misread line stops nobody: it may not even be theirs, and the printed total
// still caps what they can log.
function logGap(s: BillState): string | null {
  const { ok, discrepancyCents } = s.reconciles;
  if (ok || discrepancyCents === null || s.printedTotalCents === null) return null;
  return `These lines add up to ${formatCents(s.printedTotalCents + discrepancyCents)}. The receipt says ${formatCents(s.printedTotalCents)}.`;
}

function openLines(s: BillState): LineItem[] {
  return s.items.filter((i) => i.claimedBy.length === 0);
}

// Only when the receipt's total is what stops the confirm: the one place the
// payer needs it, right above the button it unblocks.
function printedRow(v: View): string {
  if (v.s.reconciles.ok) return "";
  return `<div class="trow" data-field-row="printedTotal"><dt>Receipt total</dt><dd>${amount(v, "printedTotal", "printed", v.s.printedTotalCents, "Receipt total")}</dd></div>`;
}

function confirmArea(v: View): string {
  const blocked = confirmBlock(v.s);
  const open = openLines(v.s).length;
  const why = blocked ?? (open === 0 ? "" : open === 1 ? "1 line has nobody on it." : `${open} lines have nobody on them.`);
  // The why rides inside the button, hidden from its name and read out as its
  // description, so the button is still just "Confirm".
  return `<div class="confirm-area">${printedRow(v)}<button type="button" class="confirm-btn" data-confirm${blocked ? " disabled" : ""}${why ? ' aria-describedby="confirm-why"' : ""}>` +
    `<span class="seal" aria-hidden="true">定</span><span class="confirm-text"><span class="confirm-word">Confirm</span>` +
    `${why ? `<span class="why${blocked ? "" : " is-hint"}" id="confirm-why" aria-hidden="true">${escapeHtml(why)}</span>` : ""}</span></button></div>`;
}

function act(attrs: string, iconName: string, title: string, sub: string | null, cls = "", chev = false): string {
  return `<button type="button" class="act${cls ? ` ${cls}` : ""}" ${attrs}>${icon(iconName)}<span class="grow"><span>${escapeHtml(title)}</span>` +
    `${sub ? `<span class="act-sub">${escapeHtml(sub)}</span>` : ""}</span>${chev ? icon("chev") : ""}</button>`;
}

// Mirrors venmoAct in the client. A payer without a Venmo on their own draft
// gets no row: the sheet at Confirm is the one place that asks them.
function venmoAct(v: View): string {
  const s = v.s;
  if (!v.onBill) return "";
  const saved = s.viewerVenmo;
  if (s.viewerIsPayer && v.bill.status === "draft" && !saved) return "";
  return act('data-venmo aria-haspopup="dialog"', "coin", "Your Venmo",
    saved ? `@${saved}` : "Add it so friends can pay you back.", "", true);
}

// The payer confirms, reopens to fix, and deletes. Anyone else on a
// confirmed bill can say something is wrong, which reopens it for the payer
// to fix. Everyone on the bill can set their Venmo.
function actions(v: View): string {
  const s = v.s;
  const parts: string[] = [];
  parts.push(venmoAct(v));
  if (s.viewerIsPayer) {
    if (v.bill.status === "draft") parts.push(confirmArea(v));
    if (v.bill.status === "confirmed") parts.push(act("data-reopen", "receipt", "Edit the bill", "Paying pauses until you confirm again."));
    parts.push(act("data-delete-bill", "basket", "Delete this bill", null));
  } else if (v.bill.status === "confirmed" && v.onBill) {
    parts.push(
      act('data-ask="wrong" aria-haspopup="dialog"', "warn", "Something's wrong", `Paying pauses until ${nameOf(v, s.payerId)} fixes it.`, "is-warn"),
    );
  }
  if (!parts.some(Boolean)) return "";
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

// Whoever still has something left to pay the payer: the people the payer can
// mark paid when the money reaches them some other way.
function unpaidBy(v: View): PaidBy[] {
  return Object.keys(v.s.owing).flatMap((id) => {
    const left = leftOf(v, id);
    return id !== v.bill.payerId && left > 0 ? [{ id, cents: left }] : [];
  });
}

// The stamp comes before the figure and the chips share a width, so the
// amounts stay on one edge whichever state a row is in. Who still owes leads.
function paymentRows(v: View): string {
  const unpaid = unpaidBy(v).map((r) => {
    const name = escapeHtml(nameOf(v, r.id));
    return `<li>${av(v, r.id)}<span class="name">${name}</span><span class="money">${formatCents(r.cents)}</span>` +
      `<button type="button" class="chip-btn" data-mark-paid="${escapeHtml(r.id)}" aria-label="Mark ${name} paid">Mark paid</button></li>`;
  });
  const paid = paidBy(v).map((r) => {
    const name = escapeHtml(nameOf(v, r.id));
    return `<li>${av(v, r.id)}<span class="name">${name}</span><span class="stamp" role="img" aria-label="Paid">付讫</span>` +
      `<span class="money">${formatCents(r.cents)}</span>` +
      `<button type="button" class="chip-btn" data-undo-paid="${escapeHtml(r.id)}" aria-label="Undo ${name}'s payment">Undo</button></li>`;
  });
  const rows = [...unpaid, ...paid];
  return rows.length > 0 ? `<h2>Payments</h2><ul>${rows.join("")}</ul>` : "";
}

// Always drawn for the payer of a confirmed bill, hidden while empty, so a
// row has somewhere to appear without a reload.
function payments(v: View): string {
  if (!v.s.viewerIsPayer || v.bill.status !== "confirmed") return "";
  const rows = paymentRows(v);
  return `<section class="card payments needs-js" data-payments aria-label="Payments"${rows ? "" : " hidden"}>${rows}</section>`;
}

function logConfirm(s: BillState): string {
  const blocked = logBlock(s);
  const gap = logGap(s);
  return `${gap ? `<p class="l-why warn">${escapeHtml(gap)}</p>` : ""}<button type="button" class="confirm-btn l-confirm" data-confirm${blocked ? " disabled" : ""}${blocked ? ' aria-describedby="confirm-why"' : ""}>` +
    `<span class="seal" aria-hidden="true">记</span><span class="confirm-word">Log it</span>` +
    `${blocked ? `<span class="l-why" id="confirm-why" aria-hidden="true">${escapeHtml(blocked)}</span>` : ""}</button>` +
    `<button type="button" class="l-act dan l-discard" data-remove-log>Discard</button>`;
}

function logItems(v: View): string {
  const everything = v.s.items.every((i) => i.claimedBy.includes(v.s.viewer));
  return `<section class="card receipt" data-items data-log-part aria-label="Receipt">
<div class="l-head"><span>What did you have?</span><button type="button" class="l-chip${everything ? " is-on" : ""}" data-everything aria-pressed="${everything}">I had everything</button></div>
<ul class="items">${v.s.items.map((i) => itemRow(v, i)).join("\n")}</ul>
${totals(v)}
</section>`;
}

function logBar(s: BillState): string {
  const spent = logSpent(s);
  return `<div class="bar l-bar" data-bar data-log-bar data-log-part><span>Your total</span>${spent > 0 ? `<span class="money">${formatCents(spent)}</span>` : `<span class="l-none">Nothing picked</span>`}</div>`;
}

function logAsk(s: BillState): string {
  if (s.place?.trim()) return "";
  return `<form class="card l-ask" data-place-form novalidate><label for="log-place">I couldn't read the name of this place.</label>` +
    `<div class="l-entry"><input id="log-place" name="place" maxlength="80" autocomplete="off" enterkeyhint="done" placeholder="Type the name">` +
    `<button type="submit" class="icon-btn go" aria-label="Save">${icon("check")}</button></div><p class="field-msg" role="status"></p></form>`;
}

function logged(v: View): string {
  const rows = v.s.items
    .filter((i) => i.claimedBy.includes(v.s.viewer))
    .map((i) => `<li><span class="item-label">${escapeHtml(i.label)}</span><span class="money">${formatCents(i.cents)}</span></li>`)
    .join("");
  return `<section class="card hero" data-log-part aria-label="What you spent">
<p class="hero-cap">You spent</p><p class="hero-amt money">${formatCents(logSpent(v.s))}</p><p class="l-sub">Items, tax share included</p>
<span class="stamp" aria-hidden="true">记</span>
</section>
${v.s.postMissing ? `<p class="l-note" data-log-part>Logged, but I couldn't post it in the channel.</p>` : ""}
<section class="card mine" data-log-part aria-label="What you had"><p class="card-h">${icon("receipt")}What you had</p><ul>${rows}</ul></section>`;
}

// One person and no money owed, so none of a split's people, guests or payments
// come along. Everything but the rows and the seal is its own, and the script
// draws these same sections.
function logBody(v: View): string {
  const s = v.s;
  const ask = `<div data-log-ask>${s.status === "draft" ? logAsk(s) : ""}</div>`;
  if (s.status === "confirmed") {
    const acts = `<button type="button" class="l-act" data-fix-name>Fix name${icon("chev")}</button><button type="button" class="l-act dan" data-remove-log>Undo${icon("chev")}</button>`;
    return `${ask}${logged(v)}<section class="card acts needs-js" data-actions aria-label="Log actions">${acts}</section>`;
  }
  return `${ask}${logItems(v)}<section class="acts l-acts needs-js" data-actions aria-label="Log it">${logConfirm(s)}</section>${logBar(s)}`;
}

function back(): string {
  return `<a class="back needs-js" href="#" data-back>${icon("back")}<span class="sr">Back</span></a>`;
}

function body(v: View): string {
  if (v.s.kind === "log") return logBody(v);
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
  const s = billState(bill, result, items, participants, viewer, extras.hasPayments ?? false, extras.paid ?? [], extras, extras, extras);
  const v: View = {
    bill,
    s,
    people: new Map(s.participants.map((p) => [p.id, p])),
    shares: new Map(result.shares.map((x) => [x.participant, x])),
    onBill: s.participants.some((p) => p.id === viewer),
    year: new Date(nowMs).getUTCFullYear(),
  };
  const layout = s.kind === "log" ? "log" : layoutOf(bill.status);
  const hasBar = s.kind === "log" ? s.editable === "self" : layout === "receipt" && v.onBill;

  const main = `${sprite()}
<main class="page${hasBar ? " has-bar" : ""}" id="bill" data-bill-id="${escapeHtml(bill.id)}" data-viewer="${escapeHtml(viewer)}" data-payer="${escapeHtml(bill.payerId)}" data-viewer-is-payer="${s.viewerIsPayer}" data-editable="${s.editable}" data-status="${bill.status}" data-revision="${bill.revision}" data-layout="${layout}">
${header(v)}
${body(v)}
</main>
<script type="application/json" id="bill-state">${scriptJson(s)}</script>
<script>${CLIENT_SCRIPT}</script>`;

  return shell(`${bill.place?.trim() || "Receipt"} · AAzhi`, main);
}
