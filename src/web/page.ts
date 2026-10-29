import type { BillRow, Participant } from "../db/bills";
import { formatCents, formatDate } from "../format";
import { debtorOf, groupByDebtor, groupOf } from "../money/debtors";
import type { Cents, LineItem, ParticipantId, Share, SplitResult } from "../money/types";
import { CLIENT_SCRIPT } from "./client";
import { billState, type BillState, type Editable } from "./state";

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

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f5f4f0;
  --surface: #ffffff;
  --text: #1b1a17;
  --muted: #67645c;
  --line: #e2dfd7;
  --accent: #4752c4;
  --accent-ink: #ffffff;
  --accent-soft: #e6e8fa;
  --accent-soft-ink: #2c3594;
  --warn: #a14a05;
  --warn-soft: #fcefdc;
  --warn-line: #e3a043;
  --ok: #1d7a3e;
  --ok-soft: #e2f3e7;
  --radius: 14px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111113;
    --surface: #1b1b1f;
    --text: #ededf0;
    --muted: #a3a2ab;
    --line: #2e2e35;
    --accent: #8f97ff;
    --accent-ink: #10122e;
    --accent-soft: #282c58;
    --accent-soft-ink: #d6d9ff;
    --warn: #f3b25a;
    --warn-soft: #382a12;
    --warn-line: #9c6718;
    --ok: #6fd897;
    --ok-soft: #16301f;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
h1, h2, p { margin: 0; }
.page {
  max-width: 640px;
  margin: 0 auto;
  padding: 20px 16px calc(40px + env(safe-area-inset-bottom));
}
.money, .item-price, dd { font-variant-numeric: tabular-nums; }
.eyebrow {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}
.head h1 { font-size: 26px; line-height: 1.2; margin-top: 4px; overflow-wrap: anywhere; }
.head .meta { color: var(--muted); margin-top: 4px; }
.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 16px;
  margin-top: 16px;
}
.you-label { font-size: 15px; font-weight: 600; color: var(--muted); }
.you-amount { font-size: 44px; font-weight: 700; line-height: 1.1; letter-spacing: -0.02em; margin-top: 4px; }
.you-detail { font-size: 15px; color: var(--muted); margin-top: 6px; }
.you-note { font-size: 15px; margin-top: 10px; }
.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin: 28px 0 6px;
}
.section-head h2 { font-size: 18px; }
.badge {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--warn);
  background: var(--warn-soft);
  border-radius: 999px;
  padding: 2px 9px;
}
.hint { font-size: 15px; color: var(--muted); margin-bottom: 12px; }
.items { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.item {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 12px;
}
.item.is-unclaimed { border-color: var(--warn-line); box-shadow: inset 4px 0 0 var(--warn-line); }
.item-line { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
button.item-line {
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
button.item-line .item-price { text-decoration: underline dotted var(--muted); text-underline-offset: 4px; }
button.item-line:focus-visible { outline: 3px solid var(--accent); outline-offset: 4px; border-radius: 4px; }
.item-label { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.item-price { font-weight: 600; white-space: nowrap; }
/* One line, always present, so a row keeps its height when its first claim
   lands or its last one goes: the chip under a finger never moves. */
.item-meta {
  font-size: 14px;
  line-height: 20px;
  height: 20px;
  margin-top: 2px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.item-flag, .item-meta.is-error { font-weight: 600; color: var(--warn); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.chip {
  min-height: 44px;
  min-width: 44px;
  max-width: 100%;
  padding: 0 14px;
  border: 1.5px solid var(--line);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 15px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
/* Pressed and unpressed share a font weight, so a toggle never changes a
   chip's width and the chips after it never reflow. */
.chip[aria-pressed="true"] {
  background: var(--accent-soft);
  border-color: var(--accent-soft);
  color: var(--accent-soft-ink);
}
.chip.is-viewer { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.chip.is-viewer[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
/* Someone else's chip reads as a name tag, not a button: no outline to tap.
   Full-contrast text still shows who is on the line. */
.chip:disabled { cursor: default; opacity: 1; border-color: transparent; }
.chip:disabled[aria-pressed="false"] { color: var(--muted); }
.chip:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.needs-js { display: none; }
.is-live .needs-js:not([hidden]) { display: block; }
.live-note {
  margin-top: 16px;
  padding: 12px 14px;
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--accent-soft-ink);
  font-weight: 600;
}
.live-note.is-warn { background: var(--warn-soft); color: var(--warn); }
.check-heading { font-size: 15px; font-weight: 600; color: var(--muted); }
.check-status { margin-top: 8px; padding: 10px 12px; border-radius: 10px; font-size: 15px; font-weight: 600; }
.check-status.is-ok { background: var(--ok-soft); color: var(--ok); }
.check-status.is-off { background: var(--warn-soft); color: var(--warn); }
.fields { margin-top: 12px; }
.field { padding: 10px 0 0; border-top: 1px solid var(--line); margin-top: 10px; }
.field-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 32px; }
.field-head label, .editor label { font-size: 15px; font-weight: 600; }
.field-row { display: flex; gap: 8px; margin-top: 6px; }
.money-input {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  border: 1.5px solid var(--line);
  border-radius: 10px;
  padding: 0 12px;
  background: var(--bg);
}
.money-input:focus-within { border-color: var(--accent); }
.money-input span { color: var(--muted); }
.money-input.is-percent span { order: 2; }
.money-input input, .text-input {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 17px;
  font-variant-numeric: tabular-nums;
  outline: none;
}
.text-input { border: 1.5px solid var(--line); border-radius: 10px; padding: 0 12px; background: var(--bg); width: 100%; }
.text-input:focus { border-color: var(--accent); }
select.text-input { flex: 1; width: auto; font-size: 17px; }
.field-note { font-size: 14px; color: var(--muted); min-height: 20px; margin-top: 4px; }
.btn {
  min-height: 44px;
  padding: 0 16px;
  border: 1.5px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn.danger { color: var(--warn); }
.btn:disabled { opacity: 0.45; cursor: default; }
.btn:focus-visible, .seg button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.seg { display: inline-flex; border: 1.5px solid var(--line); border-radius: 999px; padding: 2px; }
.seg button {
  min-width: 44px;
  min-height: 32px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.seg button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-soft-ink); }
.editor { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); display: grid; gap: 10px; }
.editor-row { display: grid; gap: 4px; }
.editor .editor-check { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 400; min-height: 32px; }
.editor-check input { width: 20px; height: 20px; margin: 0; }
.editor-msg { font-size: 14px; font-weight: 600; color: var(--warn); min-height: 20px; }
.editor-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.editor-actions .danger { margin-left: auto; }
.add-line { margin-top: 10px; }
.add-line.is-open { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; }
.add-line.is-open .editor { margin-top: 0; padding-top: 0; border-top: 0; }
.btn-add { width: 100%; border-style: dashed; color: var(--accent); }
.empty { color: var(--muted); }
.people { list-style: none; margin: 0; padding: 0 16px; }
.person {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}
.person:last-child { border-bottom: 0; }
.person-name { min-width: 0; overflow-wrap: anywhere; }
/* Tags wrap under the name flush left, not indented by their own margin. */
.people .person-name { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
.people .person-name .tag { margin-left: 0; }
.person.is-viewer { font-weight: 700; }
.tag {
  display: inline-block;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 0 7px;
  margin-left: 6px;
  vertical-align: 1px;
}
.totals { margin: 0; }
.totals .row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; }
.totals dt { color: var(--muted); }
.totals dd { margin: 0; }
.totals .grand { border-top: 1px solid var(--line); margin-top: 6px; padding-top: 12px; font-size: 18px; font-weight: 700; }
.totals .grand dt { color: var(--text); }
.totals .short, .totals .short dt { color: var(--warn); font-weight: 600; }
.money.is-forgiven { text-decoration: line-through; color: var(--muted); }
/* The forgive column has a fixed width and every row reserves it, so the
   amounts line up whether or not a row can be forgiven. */
.people.has-forgive .person {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 96px;
  align-items: center;
  padding: 8px 0;
  min-height: 61px;
}
.forgive-slot { display: flex; justify-content: flex-end; }
.btn.forgive { width: 100%; padding: 0 10px; font-size: 15px; }
.btn.forgive[aria-busy="true"] { cursor: progress; }
.btn.forgive[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent-soft); color: var(--accent-soft-ink); }
.guest-form { margin-top: 10px; }
.guest-form .check-heading { margin: 0 0 2px; }
.guest-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-top: 10px; }
.guest-form select.text-input { width: 100%; }
.guest-form .editor-msg { margin-top: 10px; }
.guest-form .editor-msg:empty { display: none; }
.guest-form .editor-actions { margin-top: 12px; }
.notice { margin-top: 18vh; text-align: center; }
.notice h1 { font-size: 24px; line-height: 1.25; }
.notice p { color: var(--muted); margin-top: 10px; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
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
  result: SplitResult;
  items: LineItem[];
  participants: Participant[];
  state: BillState;
  viewer: ParticipantId;
  viewerIsPayer: boolean;
  editable: Editable;
  names: Map<ParticipantId, string>;
  shares: Map<ParticipantId, Share>;
  paid: Set<ParticipantId>;
}

// The script in client.ts renders the same words from the same state; a
// change to any copy here needs the matching change there.
const STATUS_LABEL: Record<BillRow["status"], string> = {
  reading: "Reading the receipt",
  draft: "Draft · amounts change as people claim",
  confirmed: "Confirmed · amounts are locked",
  superseded: "Replaced by a newer split",
  deleted: "Deleted",
};

// The amount as typed into an input: no symbol, no thousands separators.
function plainDollars(cents: Cents): string {
  return formatCents(cents).replace(/[$,]/g, "");
}

function header(v: View): string {
  const date = formatDate(v.bill.billDate);
  const payer = v.viewerIsPayer ? "You" : escapeHtml(v.names.get(v.bill.payerId) ?? "Someone");
  const meta = [date, `${payer} paid`].filter(Boolean).join(" · ");
  return `<header class="head">
<p class="eyebrow" data-status-label>${STATUS_LABEL[v.bill.status]}</p>
<h1>${escapeHtml(v.bill.place?.trim() || "Receipt")}</h1>
<p class="meta">${meta}</p>
</header>
<p class="live-note" data-live-note role="status" hidden></p>`;
}

function and(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

// "Includes Sam's $25.34. Gavin forgave your $43.73." What the viewer's one
// amount is made of, when it is more than their own share or less.
function youExtra(v: View, own: Share, guests: Share[]): string {
  const payer = escapeHtml(v.names.get(v.bill.payerId) ?? "the person who paid");
  const name = (s: Share) => escapeHtml(v.names.get(s.participant) ?? "your guest");
  const owing = guests.filter((g) => !g.pardoned).map((g) => `${name(g)}'s ${formatCents(g.owedCents)}`);
  const forgiven = [
    ...(own.pardoned ? [`your ${formatCents(own.owedCents)}`] : []),
    ...guests.filter((g) => g.pardoned).map((g) => `${name(g)}'s ${formatCents(g.owedCents)}`),
  ];
  return [owing.length > 0 ? `Includes ${and(owing)}.` : "", forgiven.length > 0 ? `${payer} forgave ${and(forgiven)}.` : ""]
    .filter(Boolean)
    .join(" ");
}

function youSummary(v: View): string {
  const group = groupOf(groupByDebtor(v.result.shares, v.participants), v.viewer);
  const share = group?.own;
  const draft = v.bill.status === "draft";
  const soFar = draft ? " so far" : "";
  const payerName = escapeHtml(v.names.get(v.bill.payerId) ?? "the person who paid");

  let label: string;
  let note: string;
  if (!group || !share) {
    label = "You're not on this bill";
    note = draft
      ? "If you were at dinner, tap <strong>Open the split</strong> on the bill in Discord to join it."
      : "Nothing here is yours to pay.";
  } else if (v.viewerIsPayer) {
    label = `Your share${soFar}`;
    note = `You paid, so the others owe you <strong class="money">${formatCents(v.state.payerCollectsCents)}</strong>${soFar}.`;
  } else {
    label = draft ? "Your share so far" : `You owe ${payerName}`;
    note = draft
      ? `You'll pay this to ${payerName} once the bill is confirmed.`
      : group.owedCents === 0 && [share, ...group.guests].some((s) => s.pardoned)
        ? `${payerName} covered your share, so there's nothing to pay.`
        : `Pay ${payerName} from the bill message in Discord.`;
  }

  // Food, tax and tip of what is still asked for, so the three add up to the
  // amount above them.
  const counted = share && group ? [share, ...group.guests].filter((s) => !s.pardoned) : [];
  const sum = (pick: (s: Share) => Cents) => formatCents(counted.reduce((n, s) => n + pick(s), 0));
  const detail =
    counted.length > 0
      ? `<p class="you-detail" data-you-detail>Food <span class="money">${sum((s) => s.subtotalCents)}</span> · ` +
        `Tax <span class="money">${sum((s) => s.taxCents)}</span> · ` +
        `Tip <span class="money">${sum((s) => s.tipCents)}</span></p>`
      : "";
  const extra = share && group ? youExtra(v, share, group.guests) : "";
  return `<section class="card you" data-you aria-labelledby="you-label">
<h2 class="you-label" id="you-label">${label}</h2>
<p class="you-amount money" data-you-owed>${formatCents(share && group ? group.owedCents : 0)}</p>
${detail}${extra ? `\n<p class="you-detail" data-you-extra>${extra}</p>` : ""}
<p class="you-note">${note}</p>
</section>`;
}

function reconcileText(state: BillState): string {
  const total = state.printedTotalCents;
  const gap = state.reconciles.discrepancyCents;
  if (state.reconciles.ok && total !== null) return `Adds up: the items and tax match the printed total of ${formatCents(total)}.`;
  if (total === null || gap === null) {
    return "Enter the printed total from the receipt to check this read. Confirm appears in Discord once it adds up.";
  }
  return (
    `Doesn't add up yet: the items and tax come to ${formatCents(total + gap)}, ` +
    `${formatCents(Math.abs(gap))} ${gap > 0 ? "more" : "less"} than the printed total of ${formatCents(total)}.`
  );
}

function moneyField(name: string, label: string, cents: Cents | null, extra = ""): string {
  const value = cents === null ? "" : plainDollars(cents);
  const id = `field-${name}`;
  return `<form class="field" data-field="${name}" novalidate>
<div class="field-head"><label for="${id}">${label}</label>${extra}</div>
<div class="field-row"><div class="money-input"><span data-unit aria-hidden="true">$</span><input id="${id}" name="value" inputmode="decimal" autocomplete="off" enterkeyhint="done" value="${value}"${name === "printedTotal" ? ' placeholder="Not entered"' : ""}></div><button type="submit" class="btn primary" disabled>Save</button></div>
<p class="field-note" data-note></p>
</form>`;
}

// Only members: a guest has no account to collect into. Rendered hidden once
// anyone has paid, since the server refuses the change then; the script shows
// or hides it as polls report payments.
function payerField(v: View): string {
  const options = v.participants
    .filter((p) => p.kind === "member")
    .map((p) => `<option value="${escapeHtml(p.id)}"${p.id === v.bill.payerId ? " selected" : ""}>${escapeHtml(p.displayName)}</option>`)
    .join("");
  return `<form class="field" data-payer-form novalidate${v.state.hasPayments ? " hidden" : ""}>
<div class="field-head"><label for="field-payer">Who paid</label></div>
<div class="field-row"><select id="field-payer" name="payer" class="text-input">${options}</select><button type="submit" class="btn primary" disabled>Save</button></div>
<p class="field-note" data-note></p>
</form>`;
}

// The payer's corrections. The status line is plain HTML, so even without the
// script the payer sees whether the read adds up; the inputs need the script.
// Rendered (hidden) for the payer even off-draft, so a reopened bill can bring
// it back without a reload.
function checkCard(v: View): string {
  if (!v.viewerIsPayer) return "";
  const ok = v.state.reconciles.ok;
  const tipMode =
    '<div class="seg" role="group" aria-label="Enter the tip as">' +
    '<button type="button" data-tip-mode="dollars" aria-pressed="true">$</button>' +
    '<button type="button" data-tip-mode="percent" aria-pressed="false">%</button></div>';
  return `<section class="card check" data-check aria-labelledby="check-heading"${v.bill.status === "draft" ? "" : " hidden"}>
<h2 class="check-heading" id="check-heading">Check the receipt</h2>
<p class="check-status ${ok ? "is-ok" : "is-off"}" data-reconcile>${reconcileText(v.state)}</p>
<div class="fields needs-js">
${moneyField("printedTotal", "Printed total", v.bill.printedTotalCents)}
${moneyField("tax", "Tax", v.bill.taxCents)}
${moneyField("tip", "Tip", v.bill.tipCents, tipMode)}
${payerField(v)}
</div>
</section>`;
}

// The viewer's own chip comes first on every line, so the chip they are most
// likely to tap is always in the same place.
function chipOrder(v: View): Participant[] {
  const me = v.participants.filter((p) => p.id === v.viewer);
  return [...me, ...v.participants.filter((p) => p.id !== v.viewer)];
}

function chip(v: View, item: LineItem, p: Participant): string {
  const isViewer = p.id === v.viewer;
  const claimed = item.claimedBy.includes(p.id);
  const canTap = v.editable === "all" || (v.editable === "self" && isViewer);
  const name = isViewer ? "You" : escapeHtml(v.names.get(p.id) ?? p.id);
  return (
    `<button type="button" class="chip${isViewer ? " is-viewer" : ""}" ` +
    `data-item="${escapeHtml(item.id)}" data-participant="${escapeHtml(p.id)}" ` +
    `aria-pressed="${claimed}"${canTap ? "" : " disabled"}>${name}</button>`
  );
}

function itemMeta(v: View, item: LineItem): string {
  const n = item.claimedBy.length;
  if (n === 0) return `<p class="item-meta item-flag">Nobody has claimed this yet</p>`;
  if (n > 1) return `<p class="item-meta">Split ${n} ways</p>`;
  const only = item.claimedBy[0]!;
  return `<p class="item-meta">Just ${only === v.viewer ? "you" : escapeHtml(v.names.get(only) ?? only)}</p>`;
}

function itemRow(v: View, item: LineItem, people: Participant[]): string {
  const unclaimed = item.claimedBy.length === 0;
  const label = escapeHtml(item.label);
  return `<li class="item${unclaimed ? " is-unclaimed" : ""}" data-item="${escapeHtml(item.id)}">
<div class="item-line"><span class="item-label">${label}</span><span class="item-price">${formatCents(item.cents)}</span></div>
${itemMeta(v, item)}
<div class="chips" role="group" aria-label="Who had ${label}">${people.map((p) => chip(v, item, p)).join("")}</div>
</li>`;
}

function hintFor(v: View): string {
  switch (v.editable) {
    case "all":
      return "You paid, so you can tap anyone onto a line, and tap a line's name or price to fix it. Tap several people on one line to split it evenly.";
    case "self":
      return "Tap <strong>You</strong> on every line you had. On a shared dish, everyone tapped on it splits it evenly.";
    case "none":
      if (v.bill.status === "draft") return "You're not on this bill, so there's nothing here for you to tap.";
      if (v.bill.status === "confirmed") return "This bill is confirmed, so these amounts are locked.";
      return "This bill can't be changed any more.";
  }
}

function itemList(v: View): string {
  const people = chipOrder(v);
  const open = v.items.filter((i) => i.claimedBy.length === 0).length;
  const badge = open > 0 ? `<span class="badge" data-unclaimed-badge>${open} unclaimed</span>` : "";
  const list =
    v.items.length > 0
      ? `<ul class="items">${v.items.map((i) => itemRow(v, i, people)).join("\n")}</ul>`
      : `<p class="empty">No items on this bill.</p>`;
  const add = v.viewerIsPayer
    ? `<div class="add-line needs-js" data-add-line${v.editable === "all" ? "" : " hidden"}>` +
      `<button type="button" class="btn btn-add" data-add-open>Add a missing line</button></div>`
    : "";
  return `<section aria-labelledby="items-heading" data-items>
<div class="section-head"><h2 id="items-heading">Items</h2>${badge}</div>
<p class="hint" data-hint>${hintFor(v)}</p>
${list}
${add}
</section>`;
}

// Forgiving is the payer's, on a confirmed bill, for anyone whose share
// someone other than the payer answers for.
function canForgive(v: View): boolean {
  return v.viewerIsPayer && v.bill.status === "confirmed";
}

function forgiveSlot(v: View, p: Participant): string {
  const share = v.shares.get(p.id);
  if (!share || debtorOf(p) === v.bill.payerId) return `<span class="forgive-slot"></span>`;
  const name = escapeHtml(p.displayName);
  return (
    `<span class="forgive-slot"><button type="button" class="btn forgive" data-forgive="${escapeHtml(p.id)}" ` +
    `aria-pressed="${share.pardoned}" aria-label="Forgive ${name}'s share"${v.paid.has(debtorOf(p)) ? " disabled" : ""}>Forgive</button></span>`
  );
}

function personRow(v: View, p: Participant): string {
  const share = v.shares.get(p.id);
  const tags: string[] = [];
  if (p.id === v.viewer) tags.push("you");
  if (p.id === v.bill.payerId) tags.push("paid");
  if (p.kind === "guest") {
    const host = p.addedBy ? v.names.get(p.addedBy) : undefined;
    tags.push(host ? `guest of ${escapeHtml(host)}` : "guest");
  }
  if (share?.pardoned) tags.push("forgiven");
  const tagHtml = tags.map((t) => `<span class="tag">${t}</span>`).join("");
  return `<li class="person${p.id === v.viewer ? " is-viewer" : ""}"><span class="person-name">${escapeHtml(p.displayName)}${tagHtml}</span><span class="money${share?.pardoned ? " is-forgiven" : ""}" data-share="${escapeHtml(p.id)}">${formatCents(share?.owedCents ?? 0)}</span>${canForgive(v) ? forgiveSlot(v, p) : ""}</li>`;
}

function forgiveNote(v: View): string {
  const blocked = v.participants.some((p) => v.shares.has(p.id) && debtorOf(p) !== v.bill.payerId && v.paid.has(debtorOf(p)));
  return (
    "Forgive a share and you cover it yourself; nobody else's amount changes." +
    (blocked ? " Someone who has paid can't be forgiven until their payments are undone in Discord." : "")
  );
}

// Rendered (hidden) for the payer off-draft too, like the receipt check, so a
// reopened bill can offer it again without a reload. Only members are offered
// as who the guest came with: a guest's share needs someone who can pay it.
function guestForm(v: View): string {
  if (!v.viewerIsPayer) return "";
  const options = v.participants
    .filter((p) => p.kind === "member")
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.displayName)}</option>`)
    .join("");
  return `<form class="card guest-form needs-js" data-guest-form novalidate${v.bill.status === "draft" ? "" : " hidden"}>
<h3 class="check-heading">Add a guest</h3>
<p class="field-note">For someone at dinner who isn't on Discord. What they had is added to the person they came with.</p>
<div class="guest-fields">
<div class="editor-row"><label for="guest-name">Name</label><input id="guest-name" class="text-input" name="name" maxlength="40" autocomplete="off" enterkeyhint="next"></div>
<div class="editor-row"><label for="guest-with">Came with</label><select id="guest-with" class="text-input" name="with"><option value="" disabled selected>Pick someone</option>${options}</select></div>
</div>
<p class="editor-msg" role="status"></p>
<div class="editor-actions"><button type="submit" class="btn primary" disabled>Add guest</button></div>
</form>`;
}

function people(v: View): string {
  const heading = v.bill.status === "draft" ? "Everyone so far" : "Everyone";
  const forgive = canForgive(v);
  return `<section aria-labelledby="people-heading" data-people>
<div class="section-head"><h2 id="people-heading" data-people-heading>${heading}</h2></div>
<p class="hint" data-forgive-note${forgive ? "" : " hidden"}>${forgive ? forgiveNote(v) : ""}</p>
<ul class="card people${forgive ? " has-forgive" : ""}">${v.participants.map((p) => personRow(v, p)).join("\n")}</ul>
${guestForm(v)}
</section>`;
}

function totals(v: View): string {
  const row = (name: string, key: string, cents: number, cls = "") =>
    `<div class="row${cls ? ` ${cls}` : ""}"><dt>${name}</dt><dd data-total="${key}">${formatCents(cents)}</dd></div>`;
  const rows = [
    row("Subtotal", "subtotal", v.result.billSubtotalCents),
    row("Tax", "tax", v.bill.taxCents),
    row("Tip", "tip", v.bill.tipCents),
    row("Total", "total", v.result.distributableCents, "grand"),
  ];
  if (v.result.unclaimedCents !== 0) rows.push(row("Not claimed yet", "unclaimed", v.result.unclaimedCents, "short"));
  return `<section aria-labelledby="totals-heading">
<div class="section-head"><h2 id="totals-heading">The bill</h2></div>
<dl class="card totals">${rows.join("\n")}</dl>
</section>`;
}

export function renderPage(
  bill: BillRow,
  result: SplitResult,
  items: LineItem[],
  participants: Participant[],
  viewer: ParticipantId,
  options: { hasPayments?: boolean; paid?: ParticipantId[] } = {},
): string {
  const state = billState(bill, result, items, participants, viewer, options.hasPayments ?? false, options.paid ?? []);
  const v: View = {
    bill,
    result,
    items,
    participants,
    state,
    viewer,
    viewerIsPayer: state.viewerIsPayer,
    editable: state.editable,
    names: new Map(participants.map((p) => [p.id, p.displayName])),
    shares: new Map(result.shares.map((s) => [s.participant, s])),
    paid: new Set(state.paid),
  };

  const main = `<main class="page" id="bill" data-bill-id="${escapeHtml(bill.id)}" data-viewer="${escapeHtml(viewer)}" data-payer="${escapeHtml(bill.payerId)}" data-viewer-is-payer="${v.viewerIsPayer}" data-editable="${v.editable}" data-status="${bill.status}" data-revision="${bill.revision}">
${header(v)}
${youSummary(v)}
${checkCard(v)}
${itemList(v)}
${people(v)}
${totals(v)}
</main>
<script type="application/json" id="bill-state">${scriptJson(state)}</script>
<script>${CLIENT_SCRIPT}</script>`;

  return shell(`${bill.place?.trim() || "Receipt"} · AAzhi`, main);
}
