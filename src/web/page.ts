import type { BillRow, Participant } from "../db/bills";
import { formatCents, formatDate } from "../format";
import type { LineItem, ParticipantId, Share, SplitResult } from "../money/types";
import { CLIENT_SCRIPT } from "./client";

export type Editable = "all" | "self" | "none";

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
.item.is-unclaimed { border-color: var(--warn-line); box-shadow: inset 4px 0 0 var(--warn-line); padding-left: 16px; }
.item-line { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.item-label { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.item-price { font-weight: 600; white-space: nowrap; }
.item-flag { font-size: 14px; font-weight: 600; color: var(--warn); margin-top: 2px; }
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
.chip[aria-pressed="true"] {
  background: var(--accent-soft);
  border-color: var(--accent-soft);
  color: var(--accent-soft-ink);
  font-weight: 600;
}
.chip.is-viewer { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.chip.is-viewer[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.chip:disabled { cursor: default; opacity: 1; }
.chip:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
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
  viewer: ParticipantId;
  viewerIsPayer: boolean;
  editable: Editable;
  names: Map<ParticipantId, string>;
  shares: Map<ParticipantId, Share>;
}

function editableFor(bill: BillRow, viewerIsPayer: boolean): Editable {
  if (bill.status !== "draft") return "none";
  return viewerIsPayer ? "all" : "self";
}

function header(v: View): string {
  const date = formatDate(v.bill.billDate);
  const payer = v.viewerIsPayer ? "You" : escapeHtml(v.names.get(v.bill.payerId) ?? "Someone");
  const meta = [date, `${payer} paid`].filter(Boolean).join(" · ");
  const status = v.bill.status === "draft" ? "Draft · amounts change as people claim" : "Confirmed";
  return `<header class="head">
<p class="eyebrow">${status}</p>
<h1>${escapeHtml(v.bill.place?.trim() || "Receipt")}</h1>
<p class="meta">${meta}</p>
</header>`;
}

function youSummary(v: View): string {
  const share = v.shares.get(v.viewer);
  const draft = v.bill.status === "draft";
  const soFar = draft ? " so far" : "";
  const payerName = escapeHtml(v.names.get(v.bill.payerId) ?? "the person who paid");

  let label: string;
  let note: string;
  if (!share) {
    label = "You're not on this bill";
    note = "Nothing here is yours to pay.";
  } else if (v.viewerIsPayer) {
    label = `Your share${soFar}`;
    note = `You paid, so the others owe you <strong class="money">${formatCents(v.result.payerCollectsCents)}</strong>${soFar}.`;
  } else {
    label = draft ? "Your share so far" : `You owe ${payerName}`;
    note = draft ? `You'll pay this to ${payerName} once the bill is confirmed.` : `Pay ${payerName} from the bill message in Discord.`;
  }

  const detail = share
    ? `<p class="you-detail" data-you-detail>Food <span class="money">${formatCents(share.subtotalCents)}</span> · ` +
      `Tax <span class="money">${formatCents(share.taxCents)}</span> · ` +
      `Tip <span class="money">${formatCents(share.tipCents)}</span></p>`
    : "";
  return `<section class="card you" data-you aria-labelledby="you-label">
<h2 class="you-label" id="you-label">${label}</h2>
<p class="you-amount money" data-you-owed>${formatCents(share?.owedCents ?? 0)}</p>
${detail}
<p class="you-note">${note}</p>
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

function itemRow(v: View, item: LineItem, people: Participant[]): string {
  const unclaimed = item.claimedBy.length === 0;
  const label = escapeHtml(item.label);
  return `<li class="item${unclaimed ? " is-unclaimed" : ""}" data-item="${escapeHtml(item.id)}">
<div class="item-line"><span class="item-label">${label}</span><span class="item-price">${formatCents(item.cents)}</span></div>
${unclaimed ? `<p class="item-flag">Nobody has claimed this yet</p>\n` : ""}<div class="chips" role="group" aria-label="Who had ${label}">${people.map((p) => chip(v, item, p)).join("")}</div>
</li>`;
}

function hintFor(editable: Editable): string {
  switch (editable) {
    case "all":
      return "You paid, so you can tap anyone onto a line. Tap several people on one line to split it evenly between them.";
    case "self":
      return "Tap <strong>You</strong> on every line you had. On a shared dish, everyone tapped on it splits it evenly.";
    case "none":
      return "This bill is confirmed, so these amounts are locked.";
  }
}

function itemList(v: View): string {
  const people = chipOrder(v);
  const open = v.items.filter((i) => i.claimedBy.length === 0).length;
  const badge = open > 0 ? `<span class="badge">${open} unclaimed</span>` : "";
  const list =
    v.items.length > 0
      ? `<ul class="items">${v.items.map((i) => itemRow(v, i, people)).join("\n")}</ul>`
      : `<p class="empty">No items on this bill.</p>`;
  return `<section aria-labelledby="items-heading">
<div class="section-head"><h2 id="items-heading">Items</h2>${badge}</div>
<p class="hint">${hintFor(v.editable)}</p>
${list}
</section>`;
}

function personRow(v: View, p: Participant): string {
  const tags: string[] = [];
  if (p.id === v.viewer) tags.push("you");
  if (p.id === v.bill.payerId) tags.push("paid");
  if (p.kind === "guest") {
    const host = p.addedBy ? v.names.get(p.addedBy) : undefined;
    tags.push(host ? `guest of ${escapeHtml(host)}` : "guest");
  }
  const tagHtml = tags.map((t) => `<span class="tag">${t}</span>`).join("");
  return `<li class="person${p.id === v.viewer ? " is-viewer" : ""}"><span class="person-name">${escapeHtml(p.displayName)}${tagHtml}</span><span class="money" data-share="${escapeHtml(p.id)}">${formatCents(v.shares.get(p.id)?.owedCents ?? 0)}</span></li>`;
}

function people(v: View): string {
  const heading = v.bill.status === "draft" ? "Everyone so far" : "Everyone";
  return `<section aria-labelledby="people-heading">
<div class="section-head"><h2 id="people-heading">${heading}</h2></div>
<ul class="card people">${v.participants.map((p) => personRow(v, p)).join("\n")}</ul>
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
): string {
  const viewerIsPayer = viewer === bill.payerId;
  const v: View = {
    bill,
    result,
    items,
    participants,
    viewer,
    viewerIsPayer,
    editable: editableFor(bill, viewerIsPayer),
    names: new Map(participants.map((p) => [p.id, p.displayName])),
    shares: new Map(result.shares.map((s) => [s.participant, s])),
  };

  const state = {
    billId: bill.id,
    viewer,
    payerId: bill.payerId,
    status: bill.status,
    revision: bill.revision,
    editable: v.editable,
    taxCents: bill.taxCents,
    tipCents: bill.tipCents,
    items,
    participants: participants.map((p) => ({ id: p.id, kind: p.kind, displayName: p.displayName, addedBy: p.addedBy })),
    result,
  };

  const main = `<main class="page" id="bill" data-bill-id="${escapeHtml(bill.id)}" data-viewer="${escapeHtml(viewer)}" data-payer="${escapeHtml(bill.payerId)}" data-viewer-is-payer="${viewerIsPayer}" data-editable="${v.editable}" data-status="${bill.status}" data-revision="${bill.revision}">
${header(v)}
${youSummary(v)}
${itemList(v)}
${people(v)}
${totals(v)}
</main>
<script type="application/json" id="bill-state">${scriptJson(state)}</script>
<script>${CLIENT_SCRIPT}</script>`;

  return shell(`${bill.place?.trim() || "Receipt"} · AAzhi`, main);
}
