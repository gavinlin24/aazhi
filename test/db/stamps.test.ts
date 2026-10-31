import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { confirmBill, getBill, setPardon } from "../../src/db/bills";
import { earnStamps, markStampsSeen, stampRows, stampsFromBill, stampsHeld, STAMPS, unseenStamps } from "../../src/db/stamps";
import { seedOuting, type Outing } from "../fixtures/outings";

const db = env.DB;
const GAVIN: [string, string] = ["gavin", "Gavin"];
const MARCUS: [string, string] = ["marcus", "Marcus"];

let serial = 0;

// Every outing gets its own day so "the third visit" has one answer.
async function outing(over: Partial<Outing> = {}): Promise<string> {
  serial += 1;
  const id = `bill-${serial}`;
  await seedOuting(db, {
    id,
    people: [GAVIN],
    alongside: MARCUS,
    items: [[`Dish ${serial}`, 1000, ["gavin"]]],
    ...over,
  });
  const at = `2026-01-${String(serial % 28 || 28).padStart(2, "0")}T12:00:${String(serial % 60).padStart(2, "0")}.000Z`;
  await db.prepare("UPDATE bills SET confirmed_at = ? WHERE id = ?").bind(at, id).run();
  return id;
}

async function log(place: string, label = `Dish ${serial}`): Promise<string> {
  serial += 1;
  const id = `log-${serial}`;
  await seedOuting(db, { id, people: [GAVIN], place, items: [[label, 1000, ["gavin"]]], draft: true });
  await db.prepare("UPDATE bills SET kind = 'log' WHERE id = ?").bind(id).run();
  const confirmed = await confirmBill(db, id, (await getBill(db, id))!.revision, "gavin");
  if (!confirmed.ok) throw new Error(`could not log ${id}`);
  return id;
}

async function earn(id: string, people = ["gavin", "marcus"], options?: { forgave?: boolean }) {
  return earnStamps(db, (await getBill(db, id))!, people, options);
}

const keysOf = async (who = "gavin", guild = "guild-1") => [...(await stampsHeld(db, guild, who)).keys()].sort();

async function pay(id: string, who: string, cents: number, recordedBy = who): Promise<void> {
  await db
    .prepare("INSERT INTO settlements (id, bill_id, participant_id, cents, recorded_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(`${id}-${who}-${serial++}`, id, who, cents, `2026-02-${String(serial % 28 || 28).padStart(2, "0")}T10:00:00.000Z`, recordedBy)
    .run();
}

// The migration's statements after the table and index, which is all of the
// backfill, against whatever rows the test has laid down.
async function runBackfill(): Promise<void> {
  const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0012"))!;
  const backfill = migration.queries.filter((q) => !/^\s*(--[^\n]*\n\s*)*CREATE (TABLE|INDEX)/.test(q));
  expect(backfill.length).toBeGreaterThan(10);
  for (const query of backfill) await db.prepare(query).run();
}

beforeEach(async () => {
  serial = 0;
  await db.prepare("DELETE FROM bills").run();
  await db.prepare("DELETE FROM stamps").run();
});

describe("earning a stamp", () => {
  it("gives First Seat for a first outing, and only once", async () => {
    const first = await outing();
    expect(await earn(first)).toEqual(expect.arrayContaining([{ who: "gavin", key: "first-seat" }, { who: "marcus", key: "first-seat" }]));
    expect(await earn(await outing())).toEqual([]);
  });

  it("doesn't count an outing with nobody else on it, unless it's a log", async () => {
    await seedOuting(db, { id: "alone", people: [GAVIN], items: [["Pho", 1000, ["gavin"]]], older: true });
    expect(await earn("alone", ["gavin"])).toEqual([]);
  });

  it("gives Host on the fifth hosted outing, not the fourth", async () => {
    for (let i = 0; i < 4; i += 1) await earn(await outing());
    expect(await keysOf()).not.toContain("host");
    await earn(await outing());
    expect(await keysOf()).toContain("host");
    expect(await keysOf("marcus")).not.toContain("host");
  });

  it("folds a place's spelling, so three spellings are a Regular", async () => {
    await outing({ place: "Saigon Kitchen" });
    await outing({ place: "saigon  kitchen!" });
    expect(await earn(await outing({ place: "SAIGON KITCHEN" }))).toContainEqual({ who: "gavin", key: "regular" });
  });

  it("gives Traveler at ten different places", async () => {
    for (let i = 0; i < 9; i += 1) await outing({ place: `Place ${i}` });
    await earn(await outing({ place: "Place 0" }));
    expect(await keysOf()).not.toContain("traveler");
    await earn(await outing({ place: "Place 9" }));
    expect(await keysOf()).toContain("traveler");
  });

  it("gives Full Table at eight people, guests included, and shows the best so far below that", async () => {
    const seven = Array.from({ length: 6 }, (_, i): [string, string] => [`p${i}`, `P${i}`]);
    const items: Outing["items"] = [...seven.map(([id]): [string, number, string[]] => [`Dish ${id}`, 500, [id]]), ["Pho", 500, ["gavin"]]];
    await earn(await outing({ people: [GAVIN, ...seven], items, alongside: undefined }));
    expect(await keysOf()).not.toContain("full-table");
    expect((await stampRows(db, "guild-1", "gavin")).find((r) => r.key === "full-table")!.progress).toBe(7);

    await earn(await outing({ people: [GAVIN, ...seven], items, alongside: undefined, guest: { name: "Sam", addedBy: "p0", item: ["Rice", 500] } }));
    expect(await keysOf()).toContain("full-table");
  });

  it("counts only a payment someone recorded themselves toward Word Kept", async () => {
    for (let i = 0; i < 9; i += 1) await pay(await outing(), "marcus", 100);
    const marked = await outing();
    await pay(marked, "marcus", 100, "gavin");
    await earn(marked);
    expect(await keysOf("marcus")).not.toContain("word-kept");
    await pay(marked, "marcus", 100);
    await earn(marked);
    expect(await keysOf("marcus")).toContain("word-kept");
  });

  it("gives Sharing the Sweet for ten shared items", async () => {
    const items: Outing["items"] = Array.from({ length: 9 }, (_, i) => [`Dish ${i}`, 400, ["gavin", "marcus"]]);
    await outing({ items, people: [GAVIN, MARCUS], alongside: undefined });
    await earn("bill-1");
    expect(await keysOf()).not.toContain("sharing");
    await earn(await outing({ items: [["Dessert", 400, ["gavin", "marcus"]]], people: [GAVIN, MARCUS], alongside: undefined }));
    expect(await keysOf()).toContain("sharing");
  });

  it("gives Hundred Flavors for 25 different items, never a money-off line", async () => {
    const items: Outing["items"] = Array.from({ length: 24 }, (_, i) => [`Dish ${i}`, 100, ["gavin"]]);
    await earn(await outing({ items: [...items, ["Coupon", -100, ["gavin"]]] }));
    expect(await keysOf()).not.toContain("hundred-flavors");
    await earn(await outing({ items: [["Dish 24", 100, ["gavin"]]] }));
    expect(await keysOf()).toContain("hundred-flavors");
  });

  it("gives Clean Books when three or more people have all paid, not before", async () => {
    const people: [string, string][] = [GAVIN, ["a", "A"], ["b", "B"], ["c", "C"]];
    const id = await outing({ people, alongside: undefined, items: [["W", 500, ["a"]], ["X", 500, ["b"]], ["Y", 500, ["c"]], ["Z", 500, ["gavin"]]] });
    await pay(id, "a", 500);
    await pay(id, "b", 500);
    await earn(id, ["b"]);
    expect(await keysOf()).not.toContain("clean-books");
    await pay(id, "c", 500);
    expect(await earn(id, ["c"])).toContainEqual({ who: "gavin", key: "clean-books" });
  });

  it("doesn't give Clean Books for two people", async () => {
    const id = await outing({ people: [GAVIN, ["a", "A"], ["b", "B"]], alongside: undefined, items: [["W", 500, ["a"]], ["X", 500, ["b"]], ["Z", 500, ["gavin"]]] });
    await pay(id, "a", 500);
    await pay(id, "b", 500);
    await earn(id, ["b"]);
    expect(await keysOf()).not.toContain("clean-books");
  });

  it("gives Magnanimous to the payer for forgiving someone", async () => {
    const id = await outing({ people: [GAVIN, MARCUS], alongside: undefined, items: [["Pho", 500, ["gavin"]], ["Bun", 500, ["marcus"]]] });
    await setPardon(db, id, "marcus", true);
    expect(await earn(id, [], { forgave: true })).toContainEqual({ who: "gavin", key: "magnanimous" });
    expect(await keysOf("marcus")).not.toContain("magnanimous");
  });

  it("lets a log earn only First Seat, Regular, Traveler and Hundred Flavors", async () => {
    let last = "";
    for (let i = 0; i < 12; i += 1) last = await log(i < 3 ? "Same Spot" : `Place ${i}`);
    for (let i = 0; i < 25; i += 1) last = await log("Same Spot", `Item ${i}`);
    await earn(last, ["gavin"]);
    expect(await keysOf()).toEqual(["first-seat", "hundred-flavors", "regular", "traveler"]);
  });

  it("doesn't count logs toward Host, however many there are", async () => {
    let last = "";
    for (let i = 0; i < 6; i += 1) last = await log("Same Spot");
    await earn(last, ["gavin"]);
    expect(await keysOf()).not.toContain("host");
    expect((await stampRows(db, "guild-1", "gavin")).find((r) => r.key === "host")!.progress).toBe(0);
  });

  it("keeps each server to itself", async () => {
    await earn(await outing());
    await earn(await outing({ guild: "guild-2", channel: "chan-2", place: "Elsewhere" }));
    expect((await stampsHeld(db, "guild-2", "gavin")).has("first-seat")).toBe(true);
    await db.prepare("DELETE FROM stamps WHERE guild_id = 'guild-2'").run();
    expect(await earn(await outing({ guild: "guild-2", channel: "chan-2", place: "Elsewhere" }))).toContainEqual({ who: "gavin", key: "first-seat" });
    const rows = await stampRows(db, "guild-2", "gavin");
    expect(rows.find((r) => r.key === "regular")!.progress).toBe(2);
  });

  it("never takes a stamp back", async () => {
    const id = await outing();
    await earn(id);
    await db.prepare("DELETE FROM bills WHERE id = ?").bind(id).run();
    await earn(await outing());
    expect(await keysOf()).toContain("first-seat");
  });

  it("leaves a draft out", async () => {
    await seedOuting(db, { id: "draft", people: [GAVIN], alongside: MARCUS, items: [["Pho", 500, ["gavin"]]], draft: true });
    expect(await earn("draft")).toEqual([]);
  });
});

describe("the Ceremony's queue", () => {
  it("holds what's new in order, until it's been seen", async () => {
    const id = await outing();
    await earn(id);
    expect((await unseenStamps(db, "guild-1", "gavin")).map((s) => s.name)).toEqual(["First Seat"]);
    await markStampsSeen(db, "guild-1", "gavin", ["first-seat"]);
    expect(await unseenStamps(db, "guild-1", "gavin")).toEqual([]);
  });

  it("is one person's and one server's", async () => {
    await earn(await outing());
    await markStampsSeen(db, "guild-2", "gavin", ["first-seat"]);
    await markStampsSeen(db, "guild-1", "marcus", ["first-seat"]);
    expect(await unseenStamps(db, "guild-1", "gavin")).toHaveLength(1);
    expect(await unseenStamps(db, "guild-1", "marcus")).toEqual([]);
  });

  it("remembers which bill earned a stamp, for that bill's post", async () => {
    const id = await outing();
    await earn(id);
    expect(await stampsFromBill(db, id, "gavin")).toEqual([{ who: "gavin", key: "first-seat" }]);
  });
});

describe("the backfill", () => {
  // Reaches every rule from history, then asks the Worker's own rules what they
  // would have given. The two have to agree, or a deploy hands out the wrong set.
  async function history(): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < 11; i += 1) ids.push(await outing({ place: i < 3 ? "Saigon Kitchen" : `Place ${i}` }));
    for (const [i, id] of ids.entries()) if (i < 10) await pay(id, "marcus", 100);
    ids.push(await outing({ guild: "guild-2", channel: "chan-2", place: "Crag Cafe" }));

    const crowd: [string, string][] = Array.from({ length: 7 }, (_, i) => [`p${i}`, `P${i}`]);
    const items: Outing["items"] = Array.from({ length: 12 }, (_, i) => [`Plate ${i}`, 800, ["gavin", `p${i % 7}`]]);
    const full = await outing({ people: [GAVIN, ...crowd], alongside: undefined, place: "Long Table", items });
    for (const [id] of crowd) await pay(full, id, 100000);
    ids.push(full);

    const flavors: Outing["items"] = Array.from({ length: 25 }, (_, i) => [`Flavor ${i}`, 100, ["marcus"]]);
    ids.push(await outing({ people: [MARCUS], alongside: ["theo", "Theo"], items: flavors, place: "Night Market" }));
    ids.push(await outing({ people: [MARCUS, ["theo", "Theo"]], alongside: undefined, items: [["Pho", 500, ["marcus"]], ["Bun", 500, ["theo"]]], pardon: "theo", place: "Pardon Place" }));

    let last = "";
    for (let i = 0; i < 3; i += 1) last = await log("Log Spot", `Log dish ${i}`);
    ids.push(last);
    return ids;
  }

  const rowsOf = async () => {
    const { results } = await db
      .prepare("SELECT guild_id, user_id, key FROM stamps ORDER BY guild_id, user_id, key")
      .all<{ guild_id: string; user_id: string; key: string }>();
    return results;
  };

  it("gives what the rules give", async () => {
    await history();
    await runBackfill();
    const fromSql = await rowsOf();
    expect(new Set(fromSql.map((r) => r.key)).size).toBe(STAMPS.length);

    await db.prepare("DELETE FROM stamps").run();
    const { results: bills } = await db.prepare("SELECT id FROM bills WHERE status = 'confirmed' ORDER BY rowid").all<{ id: string }>();
    const forgiven = await db.prepare("SELECT bill_id FROM shares WHERE pardoned = 1").first<string>("bill_id");
    for (const { id } of bills) {
      const { results: people } = await db.prepare("SELECT id FROM participants WHERE bill_id = ? AND kind = 'member'").bind(id).all<{ id: string }>();
      await earn(id, people.map((p) => p.id), { forgave: id === forgiven });
    }
    expect(fromSql).toEqual(await rowsOf());
  });

  it("marks them seen and ties them to no bill, so no Ceremony plays and no post changes", async () => {
    await history();
    await runBackfill();
    const { results } = await db.prepare("SELECT * FROM stamps").all<{ seen_at: string | null; bill_id: string | null }>();
    expect(results.length).toBeGreaterThan(10);
    expect(results.every((r) => r.seen_at !== null && r.bill_id === null)).toBe(true);
  });

  it("dates a stamp when it was crossed, not today", async () => {
    await outing({ place: "One" });
    await outing({ place: "One" });
    await outing({ place: "One" });
    await outing({ place: "Two" });
    await runBackfill();
    const held = await stampsHeld(db, "guild-1", "gavin");
    expect(held.get("first-seat")).toBe("2026-01-01T12:00:01.000Z");
    expect(held.get("regular")).toBe("2026-01-03T12:00:03.000Z");
  });

  it("leaves drafts, and bills with nobody else on them, out", async () => {
    await seedOuting(db, { id: "draft", people: [GAVIN], alongside: MARCUS, items: [["Pho", 500, ["gavin"]]], draft: true });
    await seedOuting(db, { id: "alone", people: [GAVIN], items: [["Pho", 500, ["gavin"]]], older: true });
    await runBackfill();
    expect(await rowsOf()).toEqual([]);
  });

  it("leaves the tables as it found them", async () => {
    await runBackfill();
    const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all();
    expect(results).toEqual([]);
  });
});
