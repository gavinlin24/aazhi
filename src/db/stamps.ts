import type { ParticipantId } from "../money/types";
import type { BillRow } from "./bills";
import { outstanding } from "./settlements";
import { confirmedMember, foldName } from "./stats";

export type StampKey =
  | "first-seat"
  | "regular"
  | "word-kept"
  | "host"
  | "traveler"
  | "hundred-flavors"
  | "sharing"
  | "full-table"
  | "clean-books"
  | "magnanimous";

export interface Stamp {
  key: StampKey;
  glyph: string;
  name: string;
  // What the Stamps page shows as the rule.
  rule: string;
  // What the Ceremony says once it's earned.
  line: string;
  goal: number;
  // Whether the page can show how far along someone is, and how.
  shows: "count" | "best" | "once";
}

// In the order the card and the Stamps page show them.
export const STAMPS: readonly Stamp[] = [
  { key: "first-seat", glyph: "初席", name: "First Seat", rule: "Your first outing in this server.", line: "You went on your first outing here.", goal: 1, shows: "once" },
  { key: "regular", glyph: "常", name: "Regular", rule: "Go to one place 3 times.", line: "You went to one place 3 times.", goal: 3, shows: "count" },
  { key: "word-kept", glyph: "诺", name: "Word Kept", rule: "Pay your share 10 times.", line: "You paid your share 10 times.", goal: 10, shows: "count" },
  { key: "host", glyph: "东道", name: "Host", rule: "Host 5 times.", line: "You hosted 5 times.", goal: 5, shows: "count" },
  { key: "traveler", glyph: "行旅", name: "Traveler", rule: "Go to 10 different places.", line: "You went to 10 different places.", goal: 10, shows: "count" },
  { key: "hundred-flavors", glyph: "百味", name: "Hundred Flavors", rule: "Try 25 different items.", line: "You tried 25 different items.", goal: 25, shows: "count" },
  { key: "sharing", glyph: "分甘", name: "Sharing the Sweet", rule: "Share 10 items.", line: "You shared 10 items.", goal: 10, shows: "count" },
  { key: "full-table", glyph: "满", name: "Full Table", rule: "Go out with 8 or more people.", line: "You went out with 8 or more people.", goal: 8, shows: "best" },
  { key: "clean-books", glyph: "清", name: "Clean Books", rule: "3 or more people all pay you.", line: "3 or more people all paid you.", goal: 1, shows: "once" },
  { key: "magnanimous", glyph: "宽", name: "Magnanimous", rule: "Forgive someone's share.", line: "You forgave someone's share.", goal: 1, shows: "once" },
];

const CLEAN_BOOKS_AT = 3;
const BY_KEY = new Map(STAMPS.map((stamp) => [stamp.key as string, stamp]));

export function stampOf(key: string): Stamp | undefined {
  return BY_KEY.get(key);
}

export interface Earned {
  who: ParticipantId;
  key: StampKey;
}

// What a page needs to play the Ceremony.
export type UnseenStamp = Pick<Stamp, "key" | "glyph" | "name" | "line">;

export interface StampRow extends Stamp {
  earnedAt: string | null;
  progress: number;
}

interface OutingRow {
  person: string;
  kind: BillRow["kind"];
  place: string | null;
  payer_id: string;
  at_table: number;
}

interface ClaimRow {
  person: string;
  kind: BillRow["kind"];
  label: string;
  shared: number;
}

type Tally = Partial<Record<StampKey, number>>;

function most(counts: Map<string, number>): number {
  return Math.max(0, ...counts.values());
}

function tally(key: string, counts: Map<string, number>): void {
  if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
}

// Unlike every stat in stats.ts this stays in one server: First Seat means
// nothing across them. The rows are the ones stats.ts counts as being there. Only
// First Seat, Regular, Traveler and Hundred Flavors take a log, the same split
// the stats make when they count a log as an outing and never as hosting.
function tallied(outings: OutingRow[], claims: ClaimRow[], paid: number): Tally {
  const splits = outings.filter((o) => o.kind === "split");
  const places = new Map<string, number>();
  for (const outing of outings) tally(foldName(outing.place ?? ""), places);
  const items = new Set(claims.map((c) => foldName(c.label)).filter(Boolean));
  return {
    "first-seat": outings.length,
    regular: most(places),
    "word-kept": paid,
    host: splits.filter((o) => o.payer_id === o.person).length,
    traveler: places.size,
    "hundred-flavors": items.size,
    sharing: claims.filter((c) => c.kind === "split" && c.shared === 1).length,
    "full-table": Math.max(0, ...splits.map((o) => o.at_table)),
  };
}

async function talliesOf(db: D1Database, guildId: string, people: ParticipantId[]): Promise<Map<ParticipantId, Tally>> {
  const who = JSON.stringify(people);
  const here = `b.guild_id = ?1 AND p.id IN (SELECT value FROM json_each(?2)) AND ${confirmedMember("p", "b")}`;
  const [outings, claims, paid] = await db.batch<unknown>([
    db
      .prepare(
        `SELECT p.id AS person, b.kind, b.place, b.payer_id,
           (SELECT COUNT(*) FROM shares t WHERE t.bill_id = b.id AND t.owed_cents > 0) AS at_table
         FROM participants p JOIN bills b ON b.id = p.bill_id WHERE ${here}`,
      )
      .bind(guildId, who),
    // Money-off lines aren't something anyone tried or shared.
    db
      .prepare(
        `SELECT p.id AS person, b.kind, i.label,
           EXISTS (SELECT 1 FROM item_claims o WHERE o.bill_item_id = i.id AND o.participant_id <> p.id) AS shared
         FROM participants p JOIN bills b ON b.id = p.bill_id
         JOIN bill_items i ON i.bill_id = b.id
         JOIN item_claims c ON c.bill_item_id = i.id AND c.participant_id = p.id
         WHERE ${here} AND i.cents > 0`,
      )
      .bind(guildId, who),
    // Counted from settlements, not shares.settled_at: a $0 share and a forgiven
    // one are "settled" with nothing paid. Only a payment the person recorded
    // themselves is keeping their word.
    db
      .prepare(
        `SELECT s.participant_id AS person, COUNT(DISTINCT s.bill_id) AS paid
         FROM settlements s JOIN bills b ON b.id = s.bill_id
         WHERE b.guild_id = ?1 AND s.participant_id IN (SELECT value FROM json_each(?2))
           AND b.status = 'confirmed' AND b.kind = 'split' AND s.recorded_by = s.participant_id
         GROUP BY s.participant_id`,
      )
      .bind(guildId, who),
  ]);
  const paidBy = new Map((paid!.results as { person: string; paid: number }[]).map((row) => [row.person, row.paid]));
  return new Map(
    people.map((person) => [
      person,
      tallied(
        (outings!.results as OutingRow[]).filter((o) => o.person === person),
        (claims!.results as ClaimRow[]).filter((c) => c.person === person),
        paidBy.get(person) ?? 0,
      ),
    ]),
  );
}

// outstanding() treats a forgiven share as owing nothing, so forgiven people
// neither block this nor count toward the three.
async function booksClean(db: D1Database, billId: string): Promise<boolean> {
  const owing = (await outstanding(db, billId)).filter((row) => row.owedCents > 0);
  return owing.length >= CLEAN_BOOKS_AT && owing.every((row) => row.settledCents >= row.owedCents);
}

async function heldBy(db: D1Database, guildId: string, people: ParticipantId[]): Promise<Set<string>> {
  const { results } = await db
    .prepare(`SELECT user_id, key FROM stamps WHERE guild_id = ?1 AND user_id IN (SELECT value FROM json_each(?2))`)
    .bind(guildId, JSON.stringify(people))
    .all<{ user_id: string; key: string }>();
  return new Set(results.map((row) => `${row.user_id}:${row.key}`));
}

// Called after a write on `bill` has landed, for everyone that write could have
// moved. Each rule is checked from the rows, so anything an earlier failure
// missed lands here too. Resolves to what is new, which is what a post announces.
export async function earnStamps(
  db: D1Database,
  bill: Pick<BillRow, "id" | "guildId" | "payerId">,
  people: ParticipantId[],
  options: { forgave?: boolean } = {},
): Promise<Earned[]> {
  const everyone = [...new Set([...people, bill.payerId])];
  const [tallies, held, clean] = await Promise.all([
    talliesOf(db, bill.guildId, everyone),
    heldBy(db, bill.guildId, everyone),
    booksClean(db, bill.id),
  ]);
  const met: Earned[] = [];
  for (const [who, counts] of tallies) {
    for (const stamp of STAMPS) if ((counts[stamp.key] ?? 0) >= stamp.goal) met.push({ who, key: stamp.key });
  }
  if (clean) met.push({ who: bill.payerId, key: "clean-books" });
  if (options.forgave) met.push({ who: bill.payerId, key: "magnanimous" });

  const fresh = met.filter((m) => !held.has(`${m.who}:${m.key}`));
  if (fresh.length === 0) return [];
  const now = new Date().toISOString();
  // RETURNING hands back only rows really written, so two taps landing together
  // can't both announce one stamp.
  const insert = db.prepare(
    `INSERT INTO stamps (guild_id, user_id, key, earned_at, bill_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING RETURNING user_id, key`,
  );
  const written = await db.batch<{ user_id: string; key: StampKey }>(fresh.map((m) => insert.bind(bill.guildId, m.who, m.key, now, bill.id)));
  return written.flatMap((r) => r.results.map((row) => ({ who: row.user_id, key: row.key })));
}

export async function stampsHeld(db: D1Database, guildId: string, who: ParticipantId): Promise<Map<string, string>> {
  const { results } = await db
    .prepare("SELECT key, earned_at FROM stamps WHERE guild_id = ? AND user_id = ?")
    .bind(guildId, who)
    .all<{ key: string; earned_at: string }>();
  return new Map(results.map((row) => [row.key, row.earned_at]));
}

// Earned first, each group in the set's own order, the way the card lays them out.
export function earnedFirst<T extends { key: string; earned: boolean }>(rows: T[]): T[] {
  return [...rows.filter((r) => r.earned), ...rows.filter((r) => !r.earned)];
}

export async function stampRows(db: D1Database, guildId: string, who: ParticipantId): Promise<StampRow[]> {
  const [held, tallies] = await Promise.all([stampsHeld(db, guildId, who), talliesOf(db, guildId, [who])]);
  const counts = tallies.get(who) ?? {};
  const rows = STAMPS.map((stamp) => ({ ...stamp, earned: held.has(stamp.key), earnedAt: held.get(stamp.key) ?? null, progress: counts[stamp.key] ?? 0 }));
  return earnedFirst(rows).map(({ earned: _earned, ...row }) => row);
}

export async function unseenStamps(db: D1Database, guildId: string, who: ParticipantId): Promise<UnseenStamp[]> {
  const { results } = await db
    .prepare("SELECT key FROM stamps WHERE user_id = ? AND guild_id = ? AND seen_at IS NULL ORDER BY earned_at, key")
    .bind(who, guildId)
    .all<{ key: string }>();
  return results.flatMap(({ key }) => {
    const stamp = stampOf(key);
    return stamp ? [{ key: stamp.key, glyph: stamp.glyph, name: stamp.name, line: stamp.line }] : [];
  });
}

export async function markStampsSeen(db: D1Database, guildId: string, who: ParticipantId, keys: string[]): Promise<void> {
  await db
    .prepare(
      `UPDATE stamps SET seen_at = ?1
       WHERE guild_id = ?2 AND user_id = ?3 AND seen_at IS NULL AND key IN (SELECT value FROM json_each(?4))`,
    )
    .bind(new Date().toISOString(), guildId, who, JSON.stringify(keys))
    .run();
}

// A log's post is written again on a rename, and has to keep saying this.
export async function stampsFromBill(db: D1Database, billId: string, who: ParticipantId): Promise<Earned[]> {
  const { results } = await db
    .prepare("SELECT key FROM stamps WHERE bill_id = ? AND user_id = ? ORDER BY earned_at, key")
    .bind(billId, who)
    .all<{ key: StampKey }>();
  return results.map(({ key }) => ({ who, key }));
}
