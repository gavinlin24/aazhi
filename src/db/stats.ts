import type { Cents, ParticipantId } from "../money/types";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// A year of peaks is what fits across a phone.
const MAX_MONTHS = 12;

// Every statistic is one server's: each query here is scoped by guild, and a
// person's name comes only from their bills in that server, because the same
// person can go by another name elsewhere. "Hosted" is always the bill's
// payer, never the member who added a guest.

// One person on one confirmed bill: the row every number here is counted from.
const OUTING_COLUMNS = `b.id AS bill_id, b.place, b.bill_date, b.created_at, b.payer_id,
  p.id AS person, p.display_name, s.owed_cents, s.pardoned,
  EXISTS (SELECT 1 FROM participants o WHERE o.bill_id = b.id AND o.id <> p.id) AS shared`;
const OUTINGS_FROM = `participants p JOIN bills b ON b.id = p.bill_id
  LEFT JOIN shares s ON s.bill_id = b.id AND s.participant_id = p.id`;
const CONFIRMED_MEMBER = `p.kind = 'member' AND b.guild_id = ?1 AND b.status = 'confirmed'`;

interface OutingDbRow {
  bill_id: string;
  place: string | null;
  bill_date: string | null;
  created_at: string;
  payer_id: string;
  person: string;
  display_name: string;
  owed_cents: number | null;
  pardoned: number | null;
  shared: number;
}

interface CompanionDbRow {
  id: string;
  name: string;
  outings: number;
  they_hosted: number;
  person_hosted: number;
}

export interface Companion {
  id: ParticipantId;
  name: string;
  outings: number;
  // Of the bills the two shared: who paid.
  theyHosted: number;
  personHosted: number;
}

export interface Named {
  name: string;
  count: number;
}

export interface MonthSpend {
  month: string;
  cents: Cents;
  outings: number;
}

export interface Summary {
  id: ParticipantId;
  name: string;
  outings: number;
  spentCents: Cents;
  hosted: number;
}

export interface Profile extends Summary {
  firstMonth: string;
  // The server's months rather than the person's, oldest first, so a peak sits
  // over the same month on everyone's page.
  months: MonthSpend[];
  frontedCents: Cents;
  favorite: Named | null;
  dish: Named | null;
  places: number;
  biggest: { cents: Cents; place: string | null };
  // Most outings first.
  companions: Companion[];
}

export type BoardName = "hosted" | "spent" | "visits";
export type BoardSpan = "month" | "all";

export interface Ranked {
  id: ParticipantId;
  name: string;
  value: number;
  rank: number;
}

export interface Boards {
  month: string;
  firstMonth: string | null;
  lists: Record<`${BoardName}:${BoardSpan}`, Ranked[]>;
}

// Names are raw OCR text, so "Saigon Kitchen" and "SAIGON KITCHEN." must land
// on one key. Done here rather than in SQL because SQLite's lower() only knows
// ASCII. Only Latin accents go, since a mark can be a vowel in other scripts.
export function foldName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]/gu, "");
}

// The printed date says when people went, but OCR can misread the year, so it
// only counts within a week of the day the bill was made.
export function monthOf(billDate: string | null, createdAt: string): string {
  const printed = billDate && /^\d{4}-\d{2}-\d{2}$/.test(billDate) ? Date.parse(`${billDate}T00:00:00Z`) : NaN;
  const trusted = Math.abs(printed - Date.parse(createdAt)) <= WEEK_MS;
  return (trusted ? billDate! : createdAt).slice(0, 7);
}

function monthAt(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

function shiftMonth(month: string, by: number): string {
  const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + by, 1));
  return date.toISOString().slice(0, 7);
}

// `items` is oldest first, so the latest wins a tie.
function commonest(items: string[]): { value: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  let best: { value: string; count: number } | null = null;
  for (const item of items) {
    const count = counts.get(item)!;
    if (!best || count >= best.count) best = { value: item, count };
  }
  return best;
}

// The name seen most, counted after folding, in the spelling used most.
function mostUsed(names: string[]): Named | null {
  const kept = names.map((n) => n.trim()).filter((n) => foldName(n) !== "");
  const key = commonest(kept.map(foldName));
  if (!key) return null;
  const spelling = commonest(kept.filter((n) => foldName(n) === key.value))!;
  return { name: spelling.value, count: key.count };
}

function spentOn(row: OutingDbRow): Cents {
  return row.pardoned === 1 ? 0 : (row.owed_cents ?? 0);
}

function hostedBy(row: OutingDbRow, who: ParticipantId): boolean {
  return row.payer_id === who && row.shared === 1;
}

function summarize(rows: OutingDbRow[]): Summary | null {
  const last = rows.at(-1);
  if (!last) return null;
  return {
    id: last.person,
    name: last.display_name,
    outings: rows.length,
    spentCents: rows.reduce((sum, r) => sum + spentOn(r), 0),
    hosted: rows.filter((r) => hostedBy(r, last.person)).length,
  };
}

function personOutings(db: D1Database, guildId: string, who: ParticipantId, columns = OUTING_COLUMNS): D1PreparedStatement {
  return db
    .prepare(`SELECT ${columns} FROM ${OUTINGS_FROM} WHERE p.id = ?2 AND ${CONFIRMED_MEMBER} ORDER BY b.created_at, b.id`)
    .bind(guildId, who);
}

// Null when the person has no confirmed bill in this server, whatever they
// have elsewhere.
export async function personSummary(db: D1Database, guildId: string, who: ParticipantId): Promise<Summary | null> {
  return summarize((await personOutings(db, guildId, who).all<OutingDbRow>()).results);
}

function monthWindow(first: string, last: string): string[] {
  const months: string[] = [];
  for (let month = last; month >= first && months.length < MAX_MONTHS; month = shiftMonth(month, -1)) months.unshift(month);
  return months;
}

function monthSpend(rows: OutingDbRow[], first: string, last: string): MonthSpend[] {
  const months = new Map(monthWindow(first, last).map((month) => [month, { month, cents: 0, outings: 0 }]));
  for (const row of rows) {
    const bucket = months.get(monthOf(row.bill_date, row.created_at));
    if (!bucket) continue;
    bucket.cents += spentOn(row);
    bucket.outings += 1;
  }
  return [...months.values()];
}

// A shared plate counts once for each person on it. Money-off lines are not
// something anyone ordered.
function dishesStatement(db: D1Database, guildId: string, who: ParticipantId): D1PreparedStatement {
  return db
    .prepare(
      `SELECT i.label FROM participants p JOIN bills b ON b.id = p.bill_id
       JOIN bill_items i ON i.bill_id = b.id
       JOIN item_claims c ON c.bill_item_id = i.id AND c.participant_id = p.id
       WHERE p.id = ?2 AND ${CONFIRMED_MEMBER} AND i.cents > 0
       ORDER BY b.created_at, b.id, i.position`,
    )
    .bind(guildId, who);
}

// SQLite takes a bare column from the row that held the MAX, so `name` is
// what they went by on the latest bill the two shared.
function companionsStatement(db: D1Database, guildId: string, who: ParticipantId): D1PreparedStatement {
  return db
    .prepare(
      `SELECT o.id, o.display_name AS name, COUNT(*) AS outings, MAX(b.created_at) AS latest,
         SUM(b.payer_id = o.id) AS they_hosted, SUM(b.payer_id = p.id) AS person_hosted
       FROM participants p JOIN bills b ON b.id = p.bill_id
       JOIN participants o ON o.bill_id = p.bill_id AND o.id <> p.id AND o.kind = 'member'
       WHERE p.id = ?2 AND ${CONFIRMED_MEMBER}
       GROUP BY o.id ORDER BY outings DESC, latest DESC, o.id`,
    )
    .bind(guildId, who);
}

// Oldest by the day it was made, which is close enough to anchor a window.
function firstBillStatement(db: D1Database, guildId: string): D1PreparedStatement {
  return db
    .prepare(`SELECT bill_date, created_at FROM bills WHERE guild_id = ? AND status = 'confirmed' ORDER BY created_at LIMIT 1`)
    .bind(guildId);
}

export async function personProfile(db: D1Database, guildId: string, who: ParticipantId, nowMs: number): Promise<Profile | null> {
  const total = "(SELECT COALESCE(SUM(t.owed_cents), 0) FROM shares t WHERE t.bill_id = b.id) AS total_cents";
  const [outings, dishes, companions, first] = await db.batch<unknown>([
    personOutings(db, guildId, who, `${OUTING_COLUMNS}, ${total}`),
    dishesStatement(db, guildId, who),
    companionsStatement(db, guildId, who),
    firstBillStatement(db, guildId),
  ]);
  const rows = outings!.results as (OutingDbRow & { total_cents: number })[];
  const summary = summarize(rows);
  if (!summary) return null;

  const monthsOf = rows.map((r) => monthOf(r.bill_date, r.created_at));
  const oldest = (first!.results as { bill_date: string | null; created_at: string }[])[0]!;
  const firstMonth = monthsOf.reduce((a, b) => (b < a ? b : a));
  const start = [monthOf(oldest.bill_date, oldest.created_at), firstMonth].reduce((a, b) => (b < a ? b : a));
  const end = [monthAt(nowMs), ...monthsOf].reduce((a, b) => (b > a ? b : a));

  const hosted = rows.filter((r) => hostedBy(r, who));
  const places = rows.flatMap((r) => (r.place ? [r.place] : []));
  const biggest = rows.reduce((a, b) => (b.total_cents >= a.total_cents ? b : a));
  return {
    ...summary,
    firstMonth,
    months: monthSpend(rows, start, end),
    frontedCents: hosted.reduce((sum, r) => sum + r.total_cents, 0),
    favorite: mostUsed(places),
    dish: mostUsed((dishes!.results as { label: string }[]).map((d) => d.label)),
    places: new Set(places.map(foldName).filter(Boolean)).size,
    biggest: { cents: biggest.total_cents, place: biggest.place?.trim() || null },
    companions: (companions!.results as CompanionDbRow[]).map((c) => ({
      id: c.id,
      name: c.name,
      outings: c.outings,
      theyHosted: c.they_hosted,
      personHosted: c.person_hosted,
    })),
  };
}

function ranked(values: Map<ParticipantId, number>, names: Map<ParticipantId, string>): Ranked[] {
  const rows = [...values]
    .filter(([, value]) => value > 0)
    .map(([id, value]) => ({ id, name: names.get(id) ?? id, value, rank: 0 }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  // Ties share a rank and the next rank skips past them: 1, 1, 3.
  rows.forEach((row, i) => {
    row.rank = i > 0 && rows[i - 1]!.value === row.value ? rows[i - 1]!.rank : i + 1;
  });
  return rows;
}

function boardLists(rows: OutingDbRow[], names: Map<ParticipantId, string>): [Ranked[], Ranked[], Ranked[]] {
  const hosted = new Map<ParticipantId, number>();
  const spent = new Map<ParticipantId, number>();
  const places = new Map<ParticipantId, Set<string>>();
  for (const row of rows) {
    if (hostedBy(row, row.person)) hosted.set(row.person, (hosted.get(row.person) ?? 0) + 1);
    spent.set(row.person, (spent.get(row.person) ?? 0) + spentOn(row));
    const key = foldName(row.place ?? "");
    if (key) places.set(row.person, (places.get(row.person) ?? new Set()).add(key));
  }
  const visits = new Map([...places].map(([id, set]) => [id, set.size]));
  return [ranked(hosted, names), ranked(spent, names), ranked(visits, names)];
}

// The board's month is the current one, or last month until the current one
// has a bill, so the 1st is never an empty page.
export async function serverBoards(db: D1Database, guildId: string, nowMs: number): Promise<Boards> {
  const { results: rows } = await db
    .prepare(`SELECT ${OUTING_COLUMNS} FROM ${OUTINGS_FROM} WHERE ${CONFIRMED_MEMBER} ORDER BY b.created_at, b.id`)
    .bind(guildId)
    .all<OutingDbRow>();
  // Rows run oldest first, so each person's latest name lands last.
  const names = new Map(rows.map((r) => [r.person, r.display_name]));
  const monthly = rows.map((row) => ({ row, month: monthOf(row.bill_date, row.created_at) }));
  const current = monthAt(nowMs);
  const month = monthly.some((m) => m.month === current) ? current : shiftMonth(current, -1);
  const [hostedMonth, spentMonth, visitsMonth] = boardLists(monthly.filter((m) => m.month === month).map((m) => m.row), names);
  const [hostedAll, spentAll, visitsAll] = boardLists(rows, names);
  return {
    month,
    firstMonth: monthly.length > 0 ? monthly.map((m) => m.month).reduce((a, b) => (b < a ? b : a)) : null,
    lists: {
      "hosted:month": hostedMonth,
      "hosted:all": hostedAll,
      "spent:month": spentMonth,
      "spent:all": spentAll,
      "visits:month": visitsMonth,
      "visits:all": visitsAll,
    },
  };
}
