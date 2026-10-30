import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { foldName, hasBillHere, monthOf, personProfile, personSummary, serverBoards, type Ranked } from "../../src/db/stats";
import { reopenBill } from "../../src/db/bills";
import { seedOuting } from "../fixtures/outings";

const db = env.DB;
const G1 = "guild-1";
const G2 = "guild-2";
const NOW = Date.UTC(2026, 9, 30, 12);

const gavin: [string, string] = ["gavin", "Gavin"];
const marcus: [string, string] = ["marcus", "Marcus"];
const priya: [string, string] = ["priya", "Priya"];
const lena: [string, string] = ["lena", "Lena"];

const scores = (rows: Ranked[]) => rows.map((r) => [r.rank, r.id, r.value]);

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
});

describe("folding a name read off a receipt", () => {
  it("treats case, spacing, punctuation and accents as the same place", () => {
    const one = foldName("Saigon Kitchen");
    for (const name of ["SAIGON KITCHEN.", "saigon  kitchen", " Saigon-Kitchen! ", "SaigonKitchen", "Saigón Kitchen"]) {
      expect(foldName(name), name).toBe(one);
    }
  });

  it("keeps scripts whose letters lean on marks, and leaves nothing of pure punctuation", () => {
    expect(foldName("ร้านอาหาร")).not.toBe(foldName("รานอาหาร"));
    expect(foldName("ブラッスリー")).not.toBe(foldName("フラッスリー"));
    expect(foldName("小 笼 包")).toBe("小笼包");
    expect(foldName("...")).toBe("");
  });
});

describe("the month a bill counts in", () => {
  it("uses the printed date within a week of the day the bill was made", () => {
    expect(monthOf("2026-09-29", "2026-10-02T01:00:00.000Z")).toBe("2026-09");
    expect(monthOf("2026-10-24", "2026-10-24T20:00:00.000Z")).toBe("2026-10");
  });

  it("falls back to the day it was made when the print is a misread or missing", () => {
    expect(monthOf("2025-10-24", "2026-10-24T20:00:00.000Z")).toBe("2026-10");
    expect(monthOf("2026-09-01", "2026-10-24T20:00:00.000Z")).toBe("2026-10");
    expect(monthOf(null, "2026-10-24T20:00:00.000Z")).toBe("2026-10");
    expect(monthOf("sometime", "2026-10-24T20:00:00.000Z")).toBe("2026-10");
  });
});

describe("the boards", () => {
  it("leaves a bill with nobody else on it off every board", async () => {
    await seedOuting(db, { id: "solo", people: [gavin], items: [["Pho", 2000, ["gavin"]]], billDate: "2026-10-05" });
    await seedOuting(db, { id: "two", people: [marcus, gavin], items: [["Pho", 2000, ["marcus"]], ["Bun", 1500, ["gavin"]]], billDate: "2026-10-06" });

    const { lists } = await serverBoards(db, G1, NOW);
    expect(scores(lists["hosted:month"])).toEqual([[1, "marcus", 1]]);
    expect(scores(lists["spent:month"])).toEqual([[1, "marcus", 2000], [2, "gavin", 1500]]);
    expect(scores(lists["visits:month"])).toEqual([[1, "gavin", 1], [1, "marcus", 1]]);
  });

  it("does not let a bystander turn a solo bill into an outing or a hosted bill", async () => {
    await seedOuting(db, { id: "b1", people: [gavin, lena], items: [["Pho", 2000, ["gavin"]]], billDate: "2026-10-05" });

    const { lists } = await serverBoards(db, G1, NOW);
    expect(lists["hosted:all"]).toEqual([]);
    expect(lists["spent:all"]).toEqual([]);
    expect(lists["visits:all"]).toEqual([]);
    expect(await personSummary(db, G1, "gavin")).toBeNull();
    expect(await personSummary(db, G1, "lena")).toBeNull();
  });

  it("counts a bill with a guest as hosted, and never counts the guest", async () => {
    await seedOuting(db, {
      id: "b1",
      people: [gavin],
      items: [["Pho", 2000, ["gavin"]]],
      guest: { name: "Sam", addedBy: "gavin", item: ["Bun", 900] },
      billDate: "2026-10-06",
    });
    const { lists } = await serverBoards(db, G1, NOW);
    expect(scores(lists["hosted:month"])).toEqual([[1, "gavin", 1]]);
    expect(scores(lists["spent:month"])).toEqual([[1, "gavin", 2000]]);
  });

  it("counts a share at confirm, paid or not, and leaves out a forgiven one", async () => {
    await seedOuting(db, {
      id: "b1",
      people: [gavin, marcus, priya],
      items: [["A", 1000, ["gavin"]], ["B", 2000, ["marcus"]], ["C", 3000, ["priya"]]],
      pardon: "priya",
      billDate: "2026-10-06",
    });
    const { lists } = await serverBoards(db, G1, NOW);
    expect(scores(lists["spent:month"])).toEqual([[1, "marcus", 2000], [2, "gavin", 1000]]);
  });

  it("counts distinct places after folding, and skips a bill with no place", async () => {
    await seedOuting(db, { id: "b1", people: [marcus], alongside: gavin, place: "The Alembic", items: [["A", 100, ["marcus"]]], billDate: "2026-10-02" });
    await seedOuting(db, { id: "b2", people: [marcus], alongside: gavin, place: "THE ALEMBIC!", items: [["A", 100, ["marcus"]]], billDate: "2026-10-03" });
    await seedOuting(db, { id: "b3", people: [marcus], alongside: gavin, place: "Saigon Kitchen", items: [["A", 100, ["marcus"]]], billDate: "2026-10-04" });
    await seedOuting(db, { id: "b4", people: [lena], alongside: priya, place: null, items: [["A", 100, ["lena"]]], billDate: "2026-10-04" });

    const { lists } = await serverBoards(db, G1, NOW);
    expect(scores(lists["visits:month"])).toEqual([[1, "gavin", 2], [1, "marcus", 2]]);
  });

  it("shares a rank on a tie and skips past it, with names in order inside the tie", async () => {
    await seedOuting(db, { id: "b1", people: [priya, gavin], items: [["A", 500, ["priya", "gavin"]]], billDate: "2026-10-02" });
    await seedOuting(db, { id: "b2", people: [gavin, priya], items: [["A", 500, ["priya", "gavin"]]], billDate: "2026-10-03" });
    await seedOuting(db, { id: "b3", people: [lena, priya], items: [["A", 500, ["priya", "lena"]]], billDate: "2026-10-04" });
    await seedOuting(db, { id: "b4", people: [marcus, priya], items: [["A", 500, ["priya", "marcus"]]], billDate: "2026-10-05" });

    const { lists } = await serverBoards(db, G1, NOW);
    expect(scores(lists["hosted:month"])).toEqual([[1, "gavin", 1], [1, "lena", 1], [1, "marcus", 1], [1, "priya", 1]]);
    expect(lists["spent:month"].map((r) => r.rank)).toEqual([1, 2, 3, 3]);
  });

  it("shows last month until this month has a bill, and all time keeps both", async () => {
    await seedOuting(db, { id: "b1", people: [gavin], alongside: lena, items: [["A", 500, ["gavin"]]], billDate: "2026-09-20" });
    const nov1 = Date.UTC(2026, 10, 1, 9);
    const dec = Date.UTC(2026, 11, 1, 9);

    await seedOuting(db, { id: "b2", people: [gavin], alongside: lena, items: [["A", 700, ["gavin"]]], billDate: "2026-10-20" });
    const onTheFirst = await serverBoards(db, G1, nov1);
    expect(onTheFirst.month).toBe("2026-10");
    expect(scores(onTheFirst.lists["spent:month"])).toEqual([[1, "gavin", 700], [2, "lena", 100]]);
    expect(scores(onTheFirst.lists["spent:all"])).toEqual([[1, "gavin", 1200], [2, "lena", 200]]);
    expect(onTheFirst.firstMonth).toBe("2026-09");

    const quiet = await serverBoards(db, G1, dec);
    expect(quiet.month).toBe("2026-11");
    expect(quiet.lists["spent:month"]).toEqual([]);
  });

  it("keeps a misread year in the month the bill was made", async () => {
    await seedOuting(db, { id: "b10", people: [gavin], alongside: lena, items: [["A", 500, ["gavin"]]], billDate: "2025-10-24", createdAt: "2026-10-24T20:00:00.000Z" });
    const { lists, firstMonth } = await serverBoards(db, G1, NOW);
    expect(scores(lists["spent:month"])).toEqual([[1, "gavin", 500], [2, "lena", 100]]);
    expect(firstMonth).toBe("2026-10");
  });

  it("leaves out drafts, reopened, superseded and deleted bills", async () => {
    await seedOuting(db, { id: "draft", people: [gavin], alongside: lena, items: [["A", 500, ["gavin"]]], draft: true });
    await seedOuting(db, { id: "reopened", people: [gavin], alongside: lena, items: [["A", 500, ["gavin"]]] });
    await reopenBill(db, "reopened");
    await seedOuting(db, { id: "gone", people: [gavin], alongside: lena, items: [["A", 500, ["gavin"]]] });
    await db.prepare("UPDATE bills SET status = 'deleted' WHERE id = 'gone'").run();
    await seedOuting(db, { id: "old", people: [gavin], alongside: lena, items: [["A", 500, ["gavin"]]] });
    await db.prepare("UPDATE bills SET status = 'superseded' WHERE id = 'old'").run();

    const { lists } = await serverBoards(db, G1, NOW);
    expect(lists["spent:all"]).toEqual([]);
    expect(await personSummary(db, G1, "gavin")).toBeNull();
  });

  it("uses the latest name from this server", async () => {
    await seedOuting(db, { id: "b1", people: [["priya", "Priya K"]], alongside: lena, items: [["A", 500, ["priya"]]], createdAt: "2026-09-01T10:00:00.000Z" });
    await seedOuting(db, { id: "b2", people: [["priya", "Priya"]], alongside: lena, items: [["A", 500, ["priya"]]], createdAt: "2026-10-01T10:00:00.000Z" });
    await seedOuting(db, { id: "b3", guild: G2, channel: "chan-2", people: [["priya", "Pri (climbing nick)"]], alongside: lena, items: [["A", 500, ["priya"]]], createdAt: "2026-10-20T10:00:00.000Z" });

    const { lists } = await serverBoards(db, G1, NOW);
    expect(lists["spent:all"].map((r) => r.name)).toEqual(["Priya", "Lena"]);
    expect((await personSummary(db, G1, "priya"))?.name).toBe("Priya");
  });
});

describe("a profile", () => {
  async function october() {
    await seedOuting(db, {
      id: "b1",
      people: [gavin, marcus],
      place: "Saigon Kitchen",
      items: [["Pho dac biet", 2000, ["gavin"]], ["Bun bo Hue", 1800, ["marcus"]]],
      billDate: "2026-08-14",
      createdAt: "2026-08-14T20:00:00.000Z",
    });
    await seedOuting(db, {
      id: "b2",
      people: [marcus, gavin, priya],
      place: "SAIGON KITCHEN.",
      items: [["PHO DAC BIET", 2100, ["gavin"]], ["Rolls", 900, ["marcus", "priya"]], ["Promo", -300, ["marcus"]]],
      billDate: "2026-10-02",
      createdAt: "2026-10-02T20:00:00.000Z",
    });
    await seedOuting(db, {
      id: "b3",
      people: [gavin],
      alongside: lena,
      place: "Little Szechuan",
      items: [["Dan dan", 6400, ["gavin"]]],
      billDate: "2026-10-09",
      createdAt: "2026-10-09T20:00:00.000Z",
    });
  }

  it("adds up what the tiles show", async () => {
    await october();
    const p = (await personProfile(db, G1, "gavin", NOW))!;

    expect(p).toMatchObject({ name: "Gavin", outings: 3, hosted: 2, places: 2, firstMonth: "2026-08" });
    expect(p.spentCents).toBe(2000 + 2100 + 6400);
    expect(p.frontedCents).toBe(3800 + 6500);
    expect(p.biggest).toEqual({ cents: 6500, place: "Little Szechuan" });
    // One spelling each, so the latest one is shown.
    expect(p.favorite).toEqual({ name: "SAIGON KITCHEN.", count: 2 });
    expect(p.dish).toEqual({ name: "PHO DAC BIET", count: 2 });
  });

  it("does not read a money-off line as something ordered", async () => {
    await october();
    const p = (await personProfile(db, G1, "marcus", NOW))!;
    expect(p.dish?.name).not.toBe("Promo");
  });

  it("gives every month from their first, so quiet months show as gaps", async () => {
    await october();
    const p = (await personProfile(db, G1, "marcus", NOW))!;
    expect(p.firstMonth).toBe("2026-08");
    expect(p.months.map((m) => [m.month, m.cents, m.outings])).toEqual([
      ["2026-08", 1800, 1],
      ["2026-09", 0, 0],
      ["2026-10", 150, 1],
    ]);
  });

  it("keeps the last twelve months once there are more", async () => {
    await seedOuting(db, { id: "b1", people: [gavin], alongside: lena, items: [["A", 500, ["gavin"]]], billDate: "2025-03-02", createdAt: "2025-03-02T20:00:00.000Z" });
    const p = (await personProfile(db, G1, "gavin", NOW))!;
    expect(p.months).toHaveLength(12);
    expect(p.months[0]!.month).toBe("2025-11");
    expect(p.months.at(-1)!.month).toBe("2026-10");
    expect(p.firstMonth).toBe("2025-03");
    expect(p.spentCents).toBe(500);
  });

  it("knows who they went with and who hosted those bills", async () => {
    await october();
    const p = (await personProfile(db, G1, "gavin", NOW))!;
    expect(p.companions).toEqual([
      { id: "marcus", name: "Marcus", inServer: true, outings: 2, theyHosted: 1, personHosted: 1 },
      { id: "lena", name: "Lena", inServer: true, outings: 1, theyHosted: 0, personHosted: 1 },
      { id: "priya", name: "Priya", inServer: true, outings: 1, theyHosted: 0, personHosted: 0 },
    ]);
  });

  it("counts nothing from a bill with nobody else on it", async () => {
    await seedOuting(db, { id: "solo", people: [lena], items: [["Toast", 1200, ["lena"]]], billDate: "2026-10-05" });
    expect(await personProfile(db, G1, "lena", NOW)).toBeNull();
    expect(await personSummary(db, G1, "lena")).toBeNull();
    expect(await hasBillHere(db, G1, "lena")).toBe(false);
  });

  it("takes a guest as somebody else, with no one to name", async () => {
    await seedOuting(db, {
      id: "b1",
      people: [lena],
      place: null,
      items: [["Toast", 1200, ["lena"]]],
      guest: { name: "Sam", addedBy: "lena", item: ["Eggs", 900] },
      billDate: "2026-10-05",
    });
    const p = (await personProfile(db, G1, "lena", NOW))!;
    expect(p).toMatchObject({ outings: 1, spentCents: 1200, hosted: 1, frontedCents: 2100, places: 0, favorite: null, companions: [] });
  });

  it("does not count someone with a $0 share as on the bill", async () => {
    await seedOuting(db, { id: "b1", people: [gavin, marcus, lena], items: [["A", 500, ["gavin"]], ["B", 700, ["marcus"]]], billDate: "2026-10-05" });
    expect(await personSummary(db, G1, "lena")).toBeNull();
    expect((await personProfile(db, G1, "gavin", NOW))!.companions.map((c) => c.id)).toEqual(["marcus"]);
  });

  it("takes the same line with a payer who ate nothing", async () => {
    await seedOuting(db, { id: "b1", people: [lena, gavin, marcus], items: [["A", 500, ["gavin"]], ["B", 700, ["marcus"]]], billDate: "2026-10-05" });
    expect(await personSummary(db, G1, "lena")).toBeNull();
    const p = (await personProfile(db, G1, "gavin", NOW))!;
    expect(p).toMatchObject({ outings: 1, hosted: 0 });
    expect(p.companions).toEqual([{ id: "marcus", name: "Marcus", inServer: true, outings: 1, theyHosted: 0, personHosted: 0 }]);
    const { lists } = await serverBoards(db, G1, NOW);
    expect(lists["hosted:all"]).toEqual([]);
  });

  it("still counts someone whose share was forgiven as out with the group", async () => {
    await seedOuting(db, { id: "b1", people: [gavin, marcus], items: [["A", 500, ["gavin"]], ["B", 700, ["marcus"]]], pardon: "marcus", billDate: "2026-10-05" });
    expect(await personSummary(db, G1, "marcus")).toMatchObject({ outings: 1, spentCents: 0 });
  });

  it("is null for someone who has only a draft here", async () => {
    await seedOuting(db, { id: "b1", people: [gavin], alongside: lena, items: [["A", 500, ["gavin"]]], draft: true });
    expect(await personProfile(db, G1, "gavin", NOW)).toBeNull();
  });
});

describe("two servers", () => {
  async function both() {
    await seedOuting(db, { id: "a1", people: [gavin, marcus], place: "Saigon Kitchen", items: [["Pho", 2000, ["gavin"]], ["Bun", 2000, ["marcus"]]], billDate: "2026-09-05" });
    await seedOuting(db, {
      id: "b1",
      guild: G2,
      channel: "chan-2",
      people: [["marcus", "Marc the Belayer"], ["theo", "Theo"]],
      place: "Crag Cafe",
      items: [["Toast", 9900, ["marcus"]], ["Eggs", 900, ["theo"]]],
      billDate: "2026-10-06",
    });
  }

  it("adds a person up across every server, under the name from the one being viewed", async () => {
    await both();
    const whole = { spentCents: 11900, outings: 2, places: 2, hosted: 1, frontedCents: 10800, firstMonth: "2026-09" };
    expect(await personProfile(db, G1, "marcus", NOW)).toMatchObject({ ...whole, name: "Marcus", biggest: { cents: 10800, place: "Crag Cafe" } });
    expect(await personProfile(db, G2, "marcus", NOW)).toMatchObject({ ...whole, name: "Marc the Belayer" });
    expect((await personProfile(db, G1, "marcus", NOW))!.months.map((m) => [m.month, m.cents])).toEqual([["2026-09", 2000], ["2026-10", 9900]]);
    expect(await personSummary(db, G1, "marcus")).toMatchObject({ name: "Marcus", outings: 2, spentCents: 11900, hosted: 1 });
  });

  it("gives someone with bills only elsewhere their latest name, and nobody a profile from nothing", async () => {
    await both();
    await seedOuting(db, { id: "b2", guild: G2, channel: "chan-2", people: [["theo", "Theo R"]], alongside: lena, items: [["Eggs", 900, ["theo"]]], billDate: "2026-10-07" });
    expect(await personSummary(db, G1, "theo")).toMatchObject({ name: "Theo R", outings: 2 });
    expect(await personProfile(db, G1, "theo", NOW)).toMatchObject({ name: "Theo R", spentCents: 1800 });
    expect(await personSummary(db, G1, "nobody")).toBeNull();
    expect(await personProfile(db, G1, "nobody", NOW)).toBeNull();
  });

  it("names people from anywhere, and says who has a bill in the server being viewed", async () => {
    await both();
    const seen = (await personProfile(db, G1, "marcus", NOW))!.companions.map((c) => [c.id, c.name, c.inServer]);
    expect(seen).toEqual([["theo", "Theo", false], ["gavin", "Gavin", true]]);
  });

  it("names a companion from the viewing server even when a later bill elsewhere says otherwise", async () => {
    await both();
    await seedOuting(db, {
      id: "b2",
      guild: G2,
      channel: "chan-2",
      people: [["gavin", "G-Force"], ["theo", "Theo"]],
      items: [["Eggs", 900, ["gavin", "theo"]]],
      billDate: "2026-10-08",
    });
    const fromG1 = (await personProfile(db, G1, "theo", NOW))!.companions;
    expect(fromG1.map((c) => [c.id, c.name, c.inServer])).toEqual([["gavin", "Gavin", true], ["marcus", "Marcus", true]]);
    const fromG2 = (await personProfile(db, G2, "theo", NOW))!.companions;
    expect(fromG2.map((c) => [c.id, c.name, c.inServer])).toEqual([["gavin", "G-Force", true], ["marcus", "Marc the Belayer", true]]);
  });

  it("does not take a draft, or a guest row, as a name or as being in the server", async () => {
    await both();
    await seedOuting(db, { id: "d1", people: [["theo", "Theo Draft"]], alongside: lena, items: [["A", 100, ["theo"]]], draft: true });
    expect(await hasBillHere(db, G1, "theo")).toBe(false);
    expect((await personProfile(db, G1, "marcus", NOW))!.companions[0]).toMatchObject({ name: "Theo", inServer: false });
  });

  it("does not put someone on a board for a solo bill here, whatever they have elsewhere", async () => {
    await both();
    await seedOuting(db, { id: "s1", people: [["theo", "Theo Solo"]], items: [["A", 100, ["theo"]]], billDate: "2026-10-09" });
    expect(await hasBillHere(db, G1, "theo")).toBe(false);
    expect(scores((await serverBoards(db, G1, NOW)).lists["spent:all"]).map(([, id]) => id)).toEqual(["marcus", "gavin"]);
    expect((await personProfile(db, G1, "marcus", NOW))!.companions[0]).toMatchObject({ name: "Theo", inServer: false });
  });

  it("knows whose bills are here", async () => {
    await both();
    expect(await hasBillHere(db, G1, "gavin")).toBe(true);
    expect(await hasBillHere(db, G1, "theo")).toBe(false);
    expect(await hasBillHere(db, G2, "theo")).toBe(true);
    expect(await hasBillHere(db, G2, "gavin")).toBe(false);
  });

  it("lists only this server's people on a board, each with their whole total", async () => {
    await both();
    const first = await serverBoards(db, G1, NOW);
    expect(scores(first.lists["spent:all"])).toEqual([[1, "marcus", 11900], [2, "gavin", 2000]]);
    expect(scores(first.lists["hosted:all"])).toEqual([[1, "gavin", 1], [1, "marcus", 1]]);
    expect(scores(first.lists["visits:all"])).toEqual([[1, "marcus", 2], [2, "gavin", 1]]);
    expect(first.lists["spent:all"].map((r) => r.name)).toEqual(["Marcus", "Gavin"]);

    const second = await serverBoards(db, G2, NOW);
    expect(scores(second.lists["spent:all"])).toEqual([[1, "marcus", 11900], [2, "theo", 900]]);
    expect(second.lists["spent:all"][0]!.name).toBe("Marc the Belayer");
  });

  it("counts a month from everywhere, for this server's people only", async () => {
    await both();
    const { month, lists } = await serverBoards(db, G1, NOW);
    expect(month).toBe("2026-10");
    expect(scores(lists["spent:month"])).toEqual([[1, "marcus", 9900]]);
  });

  it("leaves a server with no bills of its own empty, whoever has bills elsewhere", async () => {
    await both();
    const { lists } = await serverBoards(db, "guild-3", NOW);
    expect(lists["spent:all"]).toEqual([]);
  });
});

describe("the indexes", () => {
  it("starts a person's outings from the person, not a scan", async () => {
    const { results } = await db
      .prepare("EXPLAIN QUERY PLAN SELECT b.id FROM participants p JOIN bills b ON b.id = p.bill_id WHERE p.id = ?1 AND b.guild_id = ?2 AND b.status = 'confirmed'")
      .bind("gavin", "guild-1")
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join("\n");
    expect(plan).toMatch(/idx_participants_person|idx_bills_guild_status/);
    expect(plan).not.toMatch(/SCAN/);
  });

  it("reads a person across servers from the person, not a scan", async () => {
    const { results } = await db
      .prepare("EXPLAIN QUERY PLAN SELECT b.id FROM participants p JOIN bills b ON b.id = p.bill_id WHERE p.id = ? AND p.kind = 'member' AND b.status = 'confirmed'")
      .bind("gavin")
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join("\n");
    expect(plan).toMatch(/idx_participants_person/);
    expect(plan).not.toMatch(/SCAN/);
  });

  it("starts a board from the server's bills, not a scan", async () => {
    const { results } = await db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT b.id FROM participants p JOIN bills b ON b.id = p.bill_id
         WHERE p.kind = 'member' AND b.status = 'confirmed' AND p.id IN (
           SELECT h.id FROM participants h JOIN bills hb ON hb.id = h.bill_id
           WHERE h.kind = 'member' AND hb.status = 'confirmed' AND hb.guild_id = ?)`,
      )
      .bind("guild-1")
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join("\n");
    expect(plan).toMatch(/idx_bills_guild_status/);
    expect(plan).not.toMatch(/SCAN/);
  });
});
