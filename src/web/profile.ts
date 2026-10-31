import type { LoggedRow } from "../db/bills";
import { earnedFirst, STAMPS, type StampRow, type UnseenStamp } from "../db/stamps";
import type { BoardName, Boards, BoardSpan, Companion, MonthSpend, Named, Profile, Ranked, Summary } from "../db/stats";
import { RECEIPT_TIME_ZONE, receiptStamp } from "../extract/receipt-time";
import { formatCents, monthName } from "../format";
import { RANK_FACE, STAMP_FACE } from "./fonts";
import { escapeHtml, hills, hueOf, icon, initialOf, notice, scriptJson, shell, sprite } from "./page";
import { PROFILE_SCRIPT } from "./profile-client";

// The token is the viewer, so every link on these pages carries it. The
// shell's no-referrer policy keeps it from leaking through a tap.
export interface Viewer {
  guildId: string;
  viewerId: string;
  guildName: string | null;
  token: string;
  // The board last open. It rides on every link so the Leaderboard tab can
  // return to it from any page, with no per-viewer state on the server.
  place: BoardPlace;
  fromBoard: boolean;
  // Proof that opened someone else's page, which their stamps need as well.
  proof: string | null;
  // The viewer's own stamps waiting for the Ceremony, on whatever page this is.
  unseen: UnseenStamp[];
}

export interface BoardPlace {
  board: BoardName;
  span: BoardSpan;
}

function base(v: Viewer): string {
  return `/g/${encodeURIComponent(v.guildId)}`;
}

function placeQuery({ board, span }: BoardPlace): string {
  return board === "hosted" && span === "month" ? "" : `&board=${board}&span=${span}`;
}

function selfUrl(v: Viewer): string {
  return `${base(v)}?t=${v.token}${placeQuery(v.place)}`;
}

function personUrl(v: Viewer, id: string): string {
  return id === v.viewerId ? selfUrl(v) : `${base(v)}/u/${encodeURIComponent(id)}?t=${v.token}${placeQuery(v.place)}`;
}

function friendQuery(v: Viewer): string {
  return `${v.proof ? `&m=${encodeURIComponent(v.proof)}` : ""}${v.fromBoard ? "&from=leaderboard" : ""}`;
}

function stampsUrl(v: Viewer, id: string = v.viewerId): string {
  return id === v.viewerId
    ? `${base(v)}/stamps?t=${v.token}${placeQuery(v.place)}`
    : `${base(v)}/u/${encodeURIComponent(id)}/stamps?t=${v.token}${placeQuery(v.place)}${friendQuery(v)}`;
}

function boardsUrl(v: Viewer, { board, span }: BoardPlace = v.place): string {
  return `${base(v)}/boards?t=${v.token}&board=${board}&span=${span}`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function times(n: number): string {
  return plural(n, "time");
}

// "May" within this year, "May 2025" once the year would be a guess.
function since(month: string, nowMs: number): string {
  const short = monthName(month).slice(0, 3);
  return month.slice(0, 4) === String(new Date(nowMs).getUTCFullYear()) ? short : `${short} ${month.slice(0, 4)}`;
}

function avatar(id: string, name: string, size: number, self = false): string {
  return `<span class="av hue-${hueOf(id)}${self ? " me" : ""}" style="--s:${size}px" aria-hidden="true">${escapeHtml(initialOf(name))}</span>`;
}

// Someone else's page lights neither tab, since You leads to the viewer's own.
type Tab = "you" | "leaderboard" | null;

function tabs(v: Viewer, on: Tab): string {
  const tab = (name: string, href: string, active: boolean) =>
    `<a class="${active ? "on" : ""}" href="${escapeHtml(href)}" data-keep${active ? ' aria-current="page"' : ""}>${name}</a>`;
  return `<span class="status"><span class="tabs nav">${tab("You", selfUrl(v), on === "you")}${tab("Leaderboard", boardsUrl(v), on === "leaderboard")}</span></span>`;
}

function head(v: Viewer, title: string, on: Tab, meta: string, long = false): string {
  return `<header class="head${long ? " is-long" : ""}">${hills(true)}<h1>${title}</h1>${tabs(v, on)}<p class="meta">${meta}</p></header>`;
}


// The mountain drawn in the first design, as numbers: 356 wide, feet at 156,
// the tallest peak 110 high, and any month at least a low swell so the ridge
// never breaks. The little offsets keep the valleys from looking ruled.
// Both ranges run past the box on each side: the rough filter shifts edges by a
// few pixels, and an edge that stops at the box leaves paper showing through.
const WIDTH = 356;
const FEET = 156;
const TALLEST = 110;
const LOWEST = 6;
const WIDEST_STEP = WIDTH / 6;
// Past this a name can't sit in a third of a card.
const LONG_NAME = 12;
// Past this a name can't share a line with the 44px tabs at phone width: ten
// Latin letters, or five Chinese characters, which are drawn twice as wide.
const HEADER_ROOM = 10;
const FAR_RANGE = "M-14 103L0 96C34 78 60 60 92 66C120 71 136 52 166 48C196 44 214 66 246 70C276 74 300 54 330 58C344 60 352 64 356 66L370 72V200H-14Z";

function n(value: number): string {
  return value.toFixed(1);
}

function ridge(heights: number[], step: number): string {
  // Handles scale with the month's width, or a young server's few months would
  // run in straight lines between tight little peaks.
  const k = step / WIDEST_STEP;
  const peakX = (i: number) => step * (i + 0.5);
  let path = `M-14 ${FEET} L-6 ${FEET}`;
  let x = -6;
  let y = FEET;
  let out = 17.8;
  heights.forEach((height, i) => {
    const px = peakX(i);
    const py = FEET - height;
    path += ` C${n(x + out)} ${n(y)} ${n(px - 11.4 * k)} ${n(py)} ${n(px)} ${n(py)}`;
    [x, y, out] = [px, py, 11.4 * k];
    const next = heights[i + 1];
    if (next === undefined) return;
    const vx = (px + peakX(i + 1)) / 2 + (i % 2 === 0 ? 2 : -2) * k;
    const vy = FEET - 0.45 * Math.min(height, next);
    path += ` C${n(x + 11 * k)} ${n(y)} ${n(vx - 17 * k)} ${n(vy)} ${n(vx)} ${n(vy)}`;
    [x, y, out] = [vx, vy, 13 * k];
  });
  return `${path} C${n(x + out)} ${n(y)} ${n(WIDTH - 11.8 * Math.max(1, k))} 154 362 154 L370 154`;
}

// A long axis has no room for three letters a month.
function monthLabel(month: string, count: number): string {
  return monthName(month).slice(0, count > 9 ? 1 : 3);
}

function monthLine(m: MonthSpend): string {
  const name = monthName(m.month);
  return m.outings === 0 ? `No outings in ${name}.` : `${formatCents(m.cents)} in ${name}, ${plural(m.outings, "outing")}.`;
}

function headerWidth(name: string): number {
  return [...name].reduce((width, char) => width + (char.codePointAt(0)! >= 0x2e80 ? 2 : 1), 0);
}

function range(months: MonthSpend[], top: number): string {
  const most = Math.max(...months.map((m) => m.cents));
  const heights = months.map((m) => (most > 0 ? Math.max(LOWEST, (m.cents / most) * TALLEST) : LOWEST));
  const step = WIDTH / months.length;
  const path = ridge(heights, step);
  const marks = months.map((m, i) => {
    const px = step * (i + 0.5);
    const py = FEET - heights[i]!;
    const [labelX, anchor] = px < 40 ? [10, "start"] : px > WIDTH - 40 ? [WIDTH - 10, "end"] : [px, "middle"];
    return (
      `<text class="peak-l" x="${n(labelX)}" y="${n(py - (i === top ? 30 : 10))}" text-anchor="${anchor}" data-l="${i}"${i === top ? "" : " hidden"}>${formatCents(m.cents)}</text>` +
      `<text class="mon${i === top ? " now" : ""}" x="${n(px)}" y="190" text-anchor="middle" data-m="${i}">${monthLabel(m.month, months.length)}</text>`
    );
  });
  const hits = months.map((m, i) => {
    const line = escapeHtml(monthLine(m));
    return `<rect class="hit" x="${n(step * i)}" y="0" width="${n(step)}" height="200" data-peak="${i}" data-line="${line}" role="button" tabindex="0" aria-label="${line}"><title>${monthName(m.month)}</title></rect>`;
  });
  const first = monthName(months[0]!.month);
  const last = monthName(months.at(-1)!.month);
  const label = months.length > 1 ? `Spending by month, ${first} to ${last}` : `Spending in ${first}`;
  return (
    `<svg class="range" viewBox="0 0 ${WIDTH} 200" role="group" aria-label="${label}">` +
    `<path class="far" d="${FAR_RANGE}" mask="url(#m-fade)" filter="url(#f-rough)"/>` +
    `<circle class="moonc" cx="${n(step * (top + 0.5))}" cy="${n(FEET - heights[top]! - 6)}" r="15"/>` +
    `<path class="mid" d="${path} V200 H-14Z" mask="url(#m-fade)" filter="url(#f-rough)"/>` +
    `<path class="edge" d="${path}" filter="url(#f-rough)"/>${marks.join("")}${hits.join("")}</svg>`
  );
}

function rangeCard(p: Profile, nowMs: number): string {
  // Latest wins a tie: the same reading the favorite tile uses.
  const top = p.months.reduce((best, m, i) => (m.cents >= p.months[best]!.cents ? i : best), 0);
  const busy = p.months.filter((m) => m.outings > 0).length;
  const sub = `${plural(p.outings, "outing")}${busy > 1 ? `. ${monthName(p.months[top]!.month)} was the big one.` : " so far."}`;
  return `<section class="card range-card" data-default="${escapeHtml(sub)}">
<div class="range-top"><p class="hero-cap">spent since ${since(p.firstMonth, nowMs)}</p><p class="hero-amt money">${formatCents(p.spentCents)}</p><p class="hero-sub">${escapeHtml(sub)}</p></div>
${range(p.months, top)}
<p class="range-hint needs-js">Tap a peak to read that month.</p>
</section>`;
}

// `pair` is the viewer seen from the profile being read, so theyHosted is the viewer.
function pairCard(p: Profile, pair: Companion | undefined): string {
  const name = escapeHtml(p.name);
  if (!pair) return `<section class="card pair-card"><p class="card-h">You and ${name}</p><p class="pair-none">No outings together yet.</p></section>`;
  const figure = (value: number, label: string) => `<div><span class="fig">${value}</span><span class="fl">${label}</span></div>`;
  return `<section class="card pair-card"><p class="card-h">You and ${name}</p><div class="figures">${figure(pair.outings, `${pair.outings === 1 ? "outing" : "outings"} together`)}${figure(pair.personHosted, `${p.name.length > LONG_NAME ? "they" : name} hosted`)}${figure(pair.theyHosted, "you hosted")}</div></section>`;
}

function serverName(v: Viewer): string {
  return v.guildName ? escapeHtml(v.guildName) : "This server";
}

function stampFace(glyph: string, earned: boolean): string {
  return `<span class="stamp-face ${earned ? "is-on" : "is-off"}" lang="zh" aria-hidden="true">${glyph}</span>`;
}

// One link, not ten: the single thing to do here is open the Stamps page, and a
// screen reader gets the count rather than ten characters.
function stampsCard(v: Viewer, id: string, held: Map<string, string>): string {
  const rows = earnedFirst(STAMPS.map((stamp) => ({ ...stamp, earned: held.has(stamp.key) })));
  const count = `${held.size} of ${STAMPS.length}`;
  return `<a class="card stamps-card" href="${escapeHtml(stampsUrl(v, id))}" aria-label="Stamps, ${count}. See them all."><p class="card-h">Stamps<span class="sub">${count}</span></p><div class="stamps-grid">${rows.map((row) => stampFace(row.glyph, row.earned)).join("")}</div><p class="stamps-foot">${serverName(v)}. Tap to see them all.</p></a>`;
}

function earnedOn(iso: string, nowMs: number): string {
  const when = new Date(iso);
  const year = (at: Date | number) => new Intl.DateTimeFormat("en-US", { timeZone: RECEIPT_TIME_ZONE, year: "numeric" }).format(at);
  const thisYear = year(when) === year(nowMs);
  return `Earned ${new Intl.DateTimeFormat("en-US", { timeZone: RECEIPT_TIME_ZONE, month: "short", day: "numeric", year: thisYear ? undefined : "numeric" }).format(when)}`;
}

function stampStatus(row: StampRow, nowMs: number): string {
  if (row.earnedAt) return earnedOn(row.earnedAt, nowMs);
  if (row.shows === "count") return `${Math.min(row.progress, row.goal)} of ${row.goal}`;
  return row.shows === "best" && row.progress > 0 ? `Best so far: ${row.progress}` : "Not yet";
}

function stampRow(row: StampRow, nowMs: number): string {
  const status = `<span class="s${row.earnedAt ? " on" : ""}">${stampStatus(row, nowMs)}</span>`;
  return `<li>${stampFace(row.glyph, row.earnedAt !== null)}<div><p class="t"><b>${row.name}</b>${status}</p><span class="l">${escapeHtml(row.rule)}</span></div></li>`;
}

export function renderStamps(person: Summary, rows: StampRow[], v: Viewer, nowMs: number): string {
  const self = person.id === v.viewerId;
  const title = self ? "Stamps" : `${escapeHtml(person.name)}'s stamps`;
  const earned = rows.filter((row) => row.earnedAt !== null).length;
  const back = self ? selfUrl(v) : `${personUrl(v, person.id)}${friendQuery(v)}`;
  const main = `${sprite()}
<main class="page" id="profile">
${head(v, title, self ? "you" : null, `${serverName(v)} <span class="dot">·</span> ${earned} of ${STAMPS.length}`, !self)}
<a class="chip-back" href="${escapeHtml(back)}">${icon("back")}Back to ${self ? "you" : escapeHtml(person.name)}</a>
<section class="card"><ul class="stamp-list">${rows.map((row) => stampRow(row, nowMs)).join("")}</ul></section>
</main>
${ceremonyData(v, true)}
<script>${PROFILE_SCRIPT}</script>`;
  return shell(`${self ? "Stamps" : `${person.name}'s stamps`} · AAzhi`, main, PROFILE_STYLES);
}

// The Stamps page leaves out the link, being where that link goes.
function ceremonyData(v: Viewer, onStamps = false): string {
  const data = { unseen: v.unseen, see: onStamps ? undefined : stampsUrl(v), seen: `${base(v)}/stamps/seen` };
  return `<script type="application/json" id="stamps-ceremony">${scriptJson(data)}</script>`;
}

function tile(art: string, value: string, label: string): string {
  return `<div class="tile2">${art}<span class="t-val">${value}</span><span class="t-lbl">${label}</span></div>`;
}

function namedTile(art: string, named: Named | null, empty: string, label: (count: number) => string, none: string): string {
  return named ? tile(art, escapeHtml(named.name), label(named.count)) : tile(art, empty, none);
}

function companionTile(v: Viewer, top: Companion | undefined): string {
  if (!top) return tile(icon("people"), "Just you", "no outings together yet");
  // Someone from another server is named but not linked: this tile is no way in.
  if (!top.inServer) return tile(avatar(top.id, top.name, 24), escapeHtml(top.name), `${plural(top.outings, "outing")} together`);
  return `<a class="tile2 is-link" href="${escapeHtml(personUrl(v, top.id))}">${avatar(top.id, top.name, 24)}${icon("chev", "go-ic")}<span class="t-val">${escapeHtml(top.name)}</span><span class="t-lbl">${plural(top.outings, "outing")} together</span></a>`;
}

function tiles(p: Profile, v: Viewer): string {
  const biggest = p.biggest.place ? `biggest bill, ${escapeHtml(p.biggest.place)}` : "biggest bill";
  return `<div class="tiles">
${namedTile(icon("bowl"), p.favorite, "No place yet", (c) => `favorite, ${plural(c, "visit")}`, "favorite")}
${namedTile(icon("dish"), p.dish, "Nothing yet", (c) => `ordered ${times(c)}`, "most ordered")}
${companionTile(v, p.companions[0])}
${tile(icon("coin", "coin"), `Hosted ${p.hosted === 1 ? "once" : times(p.hosted)}`, `fronted, <span class="money">${formatCents(p.frontedCents)}</span>`)}
${tile(icon("receipt"), `<span class="money">${formatCents(p.biggest.cents)}</span>`, biggest)}
${tile(icon("pin"), plural(p.places, "place"), "unique visits")}
</div>`;
}

function logDay(log: LoggedRow, nowMs: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: RECEIPT_TIME_ZONE }).format(nowMs);
  return log.billDate === today ? "Today" : (receiptStamp(log.billDate, null) ?? "Logged");
}

// Only ever on your own profile, and every server's, since a log is yours
// wherever you logged it. This is where you fix one once its link has run out.
function logsCard(logs: LoggedRow[], v: Viewer, nowMs: number): string {
  if (logs.length === 0) return "";
  const rows = logs.map((log) => {
    const line = `${logDay(log, nowMs)} · ${formatCents(log.cents)}`;
    return `<li data-log="${escapeHtml(log.id)}"><span class="log-seal" aria-hidden="true">记</span><span class="log-text"><span class="log-place">${escapeHtml(log.place ?? "Receipt")}</span>` +
      `<span class="log-line">${line}</span></span><button type="button" class="log-btn" data-log-rename>Rename</button><button type="button" class="log-btn is-danger" data-log-remove>Remove</button></li>`;
  });
  return `<section class="card logs" data-logs="${escapeHtml(v.guildId)}"><p class="card-h">Your logs<span class="sub">Only you see this</span></p><ul>${rows.join("")}</ul></section>`;
}

export function renderProfile(p: Profile, v: Viewer, nowMs: number, logs: LoggedRow[], stamps: Map<string, string>): string {
  const self = p.id === v.viewerId;
  const title = `${avatar(p.id, p.name, 30, self)}${escapeHtml(p.name)}`;
  const back = v.fromBoard
    ? `<a class="chip-back" href="${escapeHtml(boardsUrl(v))}">${icon("back")}Back to leaderboard</a>`
    : `<a class="chip-back" href="${escapeHtml(selfUrl(v))}">${icon("back")}Back to you</a>`;
  const main = `${sprite()}
<main class="page" id="profile">
${head(v, title, self ? "you" : null, `Every server <span class="dot">·</span> since ${since(p.firstMonth, nowMs)}`, headerWidth(p.name) > HEADER_ROOM)}
${self ? "" : back}
${rangeCard(p, nowMs)}
${stampsCard(v, p.id, stamps)}
${self ? "" : pairCard(p, p.companions.find((c) => c.id === v.viewerId))}
${tiles(p, v)}
${self ? logsCard(logs, v, nowMs) : ""}
</main>
${ceremonyData(v)}
<script>${PROFILE_SCRIPT}</script>`;
  return shell(`${p.name} · AAzhi`, main, PROFILE_STYLES);
}

// Reached by the You tab or a stale link, never from the reply, which gives
// no button in this case. It means no bills anywhere.
export function renderNoBills(v: Viewer, self: boolean): string {
  const line = self ? "You have no bills yet." : "No bills yet.";
  const main = `${sprite()}
<main class="page" id="profile">
${head(v, "Profile", self ? "you" : null, "Every server")}
<section class="card pair-card"><p class="pair-none">${line}</p></section>
</main>`;
  return shell("Profile · AAzhi", main, PROFILE_STYLES);
}

export function renderPersonRefused(): string {
  return notice("This profile can't open here", "Profiles open for people in this server. Run <strong>/profile</strong> with their name in Discord.");
}

export function renderProfileRefused(): string {
  return notice("This link has expired", "Profile links last 30 minutes and only work for the person who asked. Run <strong>/profile</strong> again for a fresh one.");
}

export function renderBoardsRefused(): string {
  return notice("This link has expired", "Leaderboard links last 30 minutes and only work for the person who asked. Run <strong>/leaderboard</strong> again for a fresh one.");
}

const NUMERALS = ["一", "二", "三"];
const FOOTS: Record<BoardName, string> = {
  hosted: "Hosted means you paid the bill and at least one other person came.",
  spent: "Spent is your own share, counted when the bill is confirmed.",
  visits: "Each different place counts once.",
};
const BOARD_TABS: [BoardName, string][] = [
  ["hosted", "Hosted"],
  ["spent", "Spent"],
  ["visits", "Places"],
];
const SPAN_TABS: [BoardSpan, string][] = [
  ["month", "Month"],
  ["all", "All time"],
];

function rankMark(rank: number): string {
  const numeral = NUMERALS[rank - 1];
  if (!numeral) return `<span class="rk">${rank}</span>`;
  return `<svg class="sl" viewBox="0 0 100 100" width="28" height="28" role="img" aria-label="Rank ${rank}"><rect class="sl-line" x="5" y="5" width="90" height="90" rx="7"/><g class="sl-red"><text x="50" y="53" font-size="64">${numeral}</text></g></svg>`;
}

function rankRow(row: Ranked, place: BoardPlace, v: Viewer): string {
  const self = row.id === v.viewerId;
  const value = place.board === "spent" ? formatCents(row.value) : String(row.value);
  // Each list is drawn ahead of the tabs, so a row carries its own board. Your
  // own page has no back chip, so only a friend's link says where it came from.
  const href = `${personUrl({ ...v, place }, row.id)}${self ? "" : "&from=leaderboard"}`;
  return `<li${self ? ' class="is-me"' : ""}><a class="rank-row" href="${escapeHtml(href)}">${rankMark(row.rank)}${avatar(row.id, row.name, 30, self)}<span class="nm"><span class="nm-t">${escapeHtml(row.name)}</span>${self ? '<span class="you">you</span>' : ""}</span><span class="num">${value}</span>${icon("chev", "go-ic")}</a></li>`;
}

function boardTab(attr: string, value: string, label: string, on: boolean, href: string): string {
  return `<a class="${on ? "on" : ""}" href="${escapeHtml(href)}" data-${attr}="${value}">${label}</a>`;
}

function boardList(boards: Boards, place: BoardPlace, heading: string, v: Viewer): string {
  const { board, span } = place;
  const shown = board === v.place.board && span === v.place.span;
  const rows = boards.lists[`${board}:${span}`];
  const list =
    rows.length > 0
      ? `<ol class="ranks">${rows.map((row) => rankRow(row, place, v)).join("")}</ol>`
      : `<p class="pair-none">${span === "month" ? `Nobody is on this board for ${heading} yet.` : "Nobody is on this board yet."}</p>`;
  const spans = SPAN_TABS.map(([s, label]) => boardTab("to", s, label, s === span, boardsUrl(v, { board, span: s }))).join("");
  return `<div data-list="${board}:${span}"${shown ? "" : " hidden"}><p class="card-h">${heading}<span class="tabs span">${spans}</span></p>${list}</div>`;
}

export function renderBoards(boards: Boards, v: Viewer): string {
  const shown = v.place;
  const headingOf = (span: BoardSpan) =>
    span === "month" ? monthName(boards.month) : boards.firstMonth ? `Since ${monthName(boards.firstMonth).slice(0, 3)}` : "All time";
  const lists = BOARD_TABS.flatMap(([board]) =>
    SPAN_TABS.map(([span]) => boardList(boards, { board, span }, headingOf(span), v)),
  );
  const main = `${sprite()}
<main class="page" id="boards" data-board="${shown.board}" data-span="${shown.span}">
${head(v, "Leaderboard", "leaderboard", v.guildName ? escapeHtml(v.guildName) : "This server", true)}
<div class="tabs wide">${BOARD_TABS.map(([b, label]) => boardTab("tab", b, label, b === shown.board, boardsUrl(v, { board: b, span: shown.span }))).join("")}</div>
<section class="card board">${lists.join("")}</section>
${BOARD_TABS.map(([b]) => `<p class="foot" data-foot="${b}"${b === shown.board ? "" : " hidden"}>${FOOTS[b]}</p>`).join("")}
<p class="foot">Totals include meals in other servers.</p>
<p class="foot">Tap a name to open that profile.</p>
</main>
${ceremonyData(v)}
<script>${PROFILE_SCRIPT}</script>`;
  return shell("Leaderboard · AAzhi", main, PROFILE_STYLES);
}

// Only these pages use these rules, so they stay out of the bill page. The
// values come from the approved board; the names avoid the bill page's own
// .row and .seg, which mean something else there.
const PROFILE_STYLES = `${RANK_FACE}${STAMP_FACE}
.head h1 { display: flex; align-items: center; gap: 9px; }
.head.is-long h1 { grid-column: 1 / -1; grid-row: 2; }
.head.is-long .status { grid-column: 2; grid-row: 3; }
.head.is-long .meta { grid-column: 1; grid-row: 3; align-self: center; flex-wrap: wrap; }
.tabs { display: inline-flex; padding: 2px; border: 1px solid var(--rule-strong); border-radius: 15px; background: color-mix(in srgb, var(--card) 70%, transparent); font-size: 14px; }
.tabs a { padding: 2px 10px; border-radius: 12px; color: inherit; text-decoration: none; }
.tabs a.on { background: var(--ink); color: var(--card); }
.head .status { height: auto; }
.tabs.nav { padding: 1px; border-radius: 24px; font-size: 15px; }
.tabs.nav a { display: grid; place-items: center; min-height: 44px; padding: 0 13px; border-radius: 22px; }
.tabs.span { margin-left: auto; padding: 1px; border-radius: 18px; font-weight: 400; }
.tabs.span a { display: grid; place-items: center; min-height: 34px; padding: 0 11px; border-radius: 15px; }
.tabs.wide { display: flex; width: 100%; margin: 0 0 8px; padding: 3px; border-radius: 20px; font-size: 15px; }
.tabs.wide a { display: grid; place-items: center; flex: 1 1 auto; min-height: 34px; padding: 0 6px; border-radius: 16px; white-space: nowrap; }
/* The approved 34px pills, with a hit area that reaches the 44px the rest of the app uses. */
.tabs.wide a, .tabs.span a { position: relative; }
.tabs.wide a::after, .tabs.span a::after { content: ""; position: absolute; inset: -5px 0; }
.dot { margin: 0 6px; }
.meta { gap: 0; }
.card + .tiles, .tiles + .card, .card + .card { margin-top: 12px; }
.chip-back { display: inline-flex; align-items: center; gap: 2px; min-height: 34px; margin: 0 0 12px; padding: 0 14px 0 8px; border: 1px solid var(--rule-strong); border-radius: 17px; background: var(--card); color: var(--ink); font-size: 15px; text-decoration: none; }
.chip-back .ic { width: 16px; height: 16px; }
.range-card { overflow: hidden; }
.range-top { padding: 18px var(--edge) 0; }
.range-top .hero-cap { margin-top: 0; }
.range-top .hero-amt { font-size: 46px; margin-top: 4px; }
.hero-sub { margin-top: 2px; color: var(--muted); font-size: 15px; }
.range { display: block; width: 100%; height: auto; margin-top: 2px; }
.range .far { fill: var(--hill-far); opacity: .42; }
.range .mid { fill: var(--hill-mid); opacity: .62; }
.range .edge { fill: none; stroke: var(--rule-strong); stroke-width: 1; }
.range .moonc { fill: var(--moon); stroke: color-mix(in srgb, var(--warn) 45%, transparent); stroke-width: 1; }
.range text { font-family: var(--serif); }
.range .peak-l { fill: var(--ink); font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums lining-nums; }
.range .mon { fill: var(--muted); font-size: 13px; }
.range .mon.now { fill: var(--ink); font-weight: 600; }
.range [hidden] { display: none; }
.range .hit { fill: transparent; cursor: pointer; outline-offset: -3px; }
.range-hint { padding: 0 var(--edge) 12px; color: var(--muted); font-size: 14px; text-align: center; }
.card-h { display: flex; align-items: center; gap: 7px; padding: 13px var(--edge) 2px; color: var(--muted); font-size: 15px; font-weight: 600; }
.card-h .sub { margin-left: auto; font-weight: 400; font-size: 14px; }
.pair-card { margin: 12px 0; }
.logs { margin: 12px 0; }
.logs ul { list-style: none; margin: 0; padding: 4px 0 2px; }
.logs li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-height: 58px; padding: 8px var(--edge); border-top: 1px solid var(--rule); }
.logs li:first-child { border-top: 0; }
.log-seal { display: grid; flex: none; place-items: center; width: 24px; height: 24px; border-radius: 3px; background: var(--seal); color: #fbf3ea; font-size: 15px; }
.log-text { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.log-place { font-size: 16px; overflow-wrap: anywhere; }
.log-line { color: var(--muted); font-size: 14px; font-variant-numeric: tabular-nums lining-nums; }
.log-btn { min-height: 44px; padding: 0 6px; border: 0; background: none; color: var(--muted); font: inherit; font-size: 15px; cursor: pointer; }
.log-btn.is-danger { color: var(--seal); }
.log-btn.is-armed { color: var(--ink); font-weight: 600; }
.log-form { display: flex; flex: 1 1 100%; gap: 8px; }
.log-form input { flex: 1; min-width: 0; min-height: 44px; padding: 0 12px; border: 1.5px solid var(--azurite); border-radius: var(--radius); background: var(--paper); color: var(--ink); font: inherit; font-size: 17px; }
.log-msg { flex: 1 1 100%; color: var(--warn); font-size: 14px; }
.stamps-card { display: block; color: inherit; text-decoration: none; }
.stamps-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 9px; padding: 12px var(--edge) 13px; }
.stamps-grid .stamp-face.is-on:nth-child(2n) { transform: rotate(2deg); }
.stamps-foot { padding: 0 var(--edge) 12px; color: var(--muted); font-size: 14px; }
.stamp-list { list-style: none; margin: 0; padding: 0; }
.stamp-list li { display: grid; grid-template-columns: 44px 1fr; gap: 12px; align-items: center; padding: 9px var(--edge); border-bottom: 1px solid var(--rule); }
.stamp-list li:last-child { border-bottom: 0; }
.stamp-list li:nth-child(2n) .stamp-face.is-on { transform: rotate(2deg); }
.stamp-list .stamp-face { width: 44px; font-size: 17px; }
.stamp-list .t { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.stamp-list b { font-size: 16px; font-weight: 600; }
.stamp-list .s { flex: none; color: var(--muted); font-size: 14px; }
.stamp-list .s.on { color: var(--ink); }
.stamp-list .l { display: block; color: var(--muted); font-size: 14px; }
.pair-none { padding: 10px var(--edge) 14px; color: var(--muted); font-size: 15px; }
.figures { display: grid; grid-template-columns: repeat(3, 1fr); padding: 6px 4px 9px; text-align: center; }
.figures > div { display: flex; flex-direction: column; min-width: 0; }
.figures > div + div { border-left: 1px solid var(--rule); }
.fig { font: 500 36px/1.05 var(--display); }
.fl { padding: 0 4px; color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
.tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.tile2 { position: relative; display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 12px 12px 11px; background: var(--card) var(--grain); border: 1px solid var(--rule-strong); border-radius: var(--radius); box-shadow: inset 0 0 0 3px var(--card), inset 0 0 0 3.75px var(--rule); color: inherit; text-decoration: none; }
.tile2 > .ic, .tile2 > .av { margin-bottom: 4px; color: var(--muted); }
.tile2 > .av { color: var(--av-ink, var(--ink)); }
.tile2 .coin { color: var(--warn); }
.tile2 .go-ic { position: absolute; right: 8px; top: 12px; width: 16px; height: 16px; margin: 0; }
.t-val { font-size: 17px; line-height: 1.25; overflow-wrap: anywhere; }
.t-lbl { font-size: 14px; color: var(--muted); overflow-wrap: anywhere; }
.t-lbl .money { color: var(--ink); }
.sl { flex: none; overflow: visible; transform: rotate(-6deg); }
.sl text { font-family: var(--brush); text-anchor: middle; dominant-baseline: central; }
.sl .sl-line { fill: color-mix(in srgb, var(--card) 70%, transparent); stroke: var(--seal); stroke-width: 6; }
.sl .sl-red text { fill: var(--seal); }
.board .card-h { padding-bottom: 8px; border-bottom: 1px solid var(--rule); }
.ranks { list-style: none; margin: 0; padding: 0; }
.ranks li { border-bottom: 1px solid var(--rule); }
.ranks li:last-child { border-bottom: 0; }
.ranks .is-me { background: color-mix(in srgb, var(--azurite-soft) 60%, transparent); }
.rank-row { display: flex; align-items: center; gap: 11px; width: 100%; min-height: 56px; padding: 6px var(--edge); color: inherit; text-decoration: none; }
.rank-row .go-ic { width: 15px; height: 15px; color: var(--muted); margin-left: -4px; }
.rk { display: inline-grid; place-items: center; flex: none; width: 28px; color: var(--muted); font-size: 15px; font-variant-numeric: tabular-nums lining-nums; }
.nm { display: flex; align-items: baseline; flex: 1; min-width: 0; font-size: 17px; }
.nm-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.you { flex: none; margin-left: 7px; color: var(--muted); font-size: 14px; }
.num { font-size: 16px; color: var(--ink); font-variant-numeric: tabular-nums lining-nums; }
.foot { margin: 12px 4px 0; color: var(--muted); font-size: 14px; text-align: center; }
.foot + .foot { margin-top: 4px; }
.foot[hidden] { display: none; }
[data-list][hidden] { display: none; }
@media (prefers-color-scheme: dark) {
  .range .far { opacity: .8; }
  .range .moonc { stroke: none; opacity: .9; }
}
`;
