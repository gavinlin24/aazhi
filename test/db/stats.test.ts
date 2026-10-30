import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { foldName, monthOf, personProfile, personSummary, serverBoards, type Ranked } from "../../src/db/stats";
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
  it("counts a payer as hosting only when someone else was on the bill", async () => {
    await seedOuting(db, { id: "solo", people: [gavin], items: [["Pho", 2000, ["gavin"]]], billDate: "2026-10-05" });
    await seedOuting(db, { id: "two", people: [marcus, gavin], items: [["Pho", 2000, ["marcus"]], ["Bun", 1500, ["gavin"]]], billDate: "2026-10-06" });

    const { lists } = await serverBoards(db, G1, NOW);
    expect(scores(lists["hosted:month"])).toEqual([[1, "marcus", 1]]);
    expect(scores(lists["spent:month"])).toEqual([[1, "gavin", 3500], [2, "marcus", 2000]]);
    expect(scores(lists["visits:month"])).toEqual([[1, "gavin", 1], [1, "marcus", 1]]);
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
    await seedOuting(db, { id: "b1", people: [marcus], place: "The Alembic", items: [["A", 100, ["marcus"]]], billDate: "2026-10-02" });
    await seedOuting(db, { id: "b2", people: [marcus], place: "THE ALEMBIC!", items: [["A", 100, ["marcus"]]], billDate: "2026-10-03" });
    await seedOuting(db, { id: "b3", people: [marcus], place: "Saigon Kitchen", items: [["A", 100, ["marcus"]]], billDate: "2026-10-04" });
    await seedOuting(db, { id: "b4", people: [lena], place: null, items: [["A", 100, ["lena"]]], billDate: "2026-10-04" });

    const { lists } = await serverBoards(db, G1, NOW);
    expect(scores(lists["visits:month"])).toEqual([[1, "marcus", 2]]);
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
    await seedOuting(db, { id: "b1", people: [gavin], items: [["A", 500, ["gavin"]]], billDate: "2026-09-20" });
    const nov1 = Date.UTC(2026, 10, 1, 9);
    const dec = Date.UTC(2026, 11, 1, 9);

    await seedOuting(db, { id: "b2", people: [gavin], items: [["A", 700, ["gavin"]]], billDate: "2026-10-20" });
    const onTheFirst = await serverBoards(db, G1, nov1);
    expect(onTheFirst.month).toBe("2026-10");
    expect(scores(onTheFirst.lists["spent:month"])).toEqual([[1, "gavin", 700]]);
    expect(scores(onTheFirst.lists["spent:all"])).toEqual([[1, "gavin", 1200]]);
    expect(onTheFirst.firstMonth).toBe("2026-09");

    const quiet = await serverBoards(db, G1, dec);
    expect(quiet.month).toBe("2026-11");
    expect(quiet.lists["spent:month"]).toEqual([]);
  });

  it("keeps a misread year in the month the bill was made", async () => {
    await seedOuting(db, { id: "b10", people: [gavin], items: [["A", 500, ["gavin"]]], billDate: "2025-10-24", createdAt: "2026-10-24T20:00:00.000Z" });
    const { lists, firstMonth } = await serverBoards(db, G1, NOW);
    expect(scores(lists["spent:month"])).toEqual([[1, "gavin", 500]]);
    expect(firstMonth).toBe("2026-10");
  });

  it("leaves out drafts, reopened, superseded and deleted bills", async () => {
    await seedOuting(db, { id: "draft", people: [gavin], items: [["A", 500, ["gavin"]]], draft: true });
    await seedOuting(db, { id: "reopened", people: [gavin], items: [["A", 500, ["gavin"]]] });
    await reopenBill(db, "reopened");
    await seedOuting(db, { id: "gone", people: [gavin], items: [["A", 500, ["gavin"]]] });
    await db.prepare("UPDATE bills SET status = 'deleted' WHERE id = 'gone'").run();
    await seedOuting(db, { id: "old", people: [gavin], items: [["A", 500, ["gavin"]]] });
    await db.prepare("UPDATE bills SET status = 'superseded' WHERE id = 'old'").run();

    const { lists } = await serverBoards(db, G1, NOW);
    expect(lists["spent:all"]).toEqual([]);
    expect(await personSummary(db, G1, "gavin")).toBeNull();
  });

  it("uses the latest name from this server", async () => {
    await seedOuting(db, { id: "b1", people: [["priya", "Priya K"]], items: [["A", 500, ["priya"]]], createdAt: "2026-09-01T10:00:00.000Z" });
    await seedOuting(db, { id: "b2", people: [["priya", "Priya"]], items: [["A", 500, ["priya"]]], createdAt: "2026-10-01T10:00:00.000Z" });
    await seedOuting(db, { id: "b3", guild: G2, channel: "chan-2", people: [["priya", "Pri (climbing nick)"]], items: [["A", 500, ["priya"]]], createdAt: "2026-10-20T10:00:00.000Z" });

    const { lists } = await serverBoards(db, G1, NOW);
    expect(lists["spent:all"].map((r) => r.name)).toEqual(["Priya"]);
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
      place: "Little Szechuan",
      items: [["Dan dan", 6400, ["gavin"]]],
      billDate: "2026-10-09",
      createdAt: "2026-10-09T20:00:00.000Z",
    });
  }

  it("adds up what the tiles show", async () => {
    await october();
    const p = (await personProfile(db, G1, "gavin", NOW))!;

    expect(p).toMatchObject({ name: "Gavin", outings: 3, hosted: 1, places: 2, firstMonth: "2026-08" });
    expect(p.spentCents).toBe(2000 + 2100 + 6400);
    expect(p.frontedCents).toBe(3800);
    expect(p.biggest).toEqual({ cents: 6400, place: "Little Szechuan" });
    // One spelling each, so the latest one is shown.
    expect(p.favorite).toEqual({ name: "SAIGON KITCHEN.", count: 2 });
    expect(p.dish).toEqual({ name: "PHO DAC BIET", count: 2 });
  });

  it("does not read a money-off line as something ordered", async () => {
    await october();
    const p = (await personProfile(db, G1, "marcus", NOW))!;
    expect(p.dish?.name).not.toBe("Promo");
  });

  it("gives every month from the server's first, so quiet months show as gaps", async () => {
    await october();
    const p = (await personProfile(db, G1, "priya", NOW))!;
    expect(p.firstMonth).toBe("2026-10");
    expect(p.months.map((m) => [m.month, m.cents, m.outings])).toEqual([
      ["2026-08", 0, 0],
      ["2026-09", 0, 0],
      ["2026-10", 450, 1],
    ]);
  });

  it("keeps the last twelve months once there are more", async () => {
    await seedOuting(db, { id: "b1", people: [gavin], items: [["A", 500, ["gavin"]]], billDate: "2025-03-02", createdAt: "2025-03-02T20:00:00.000Z" });
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
      { id: "marcus", name: "Marcus", outings: 2, theyHosted: 1, personHosted: 1 },
      { id: "priya", name: "Priya", outings: 1, theyHosted: 0, personHosted: 0 },
    ]);
  });

  it("shows one person's bill with nobody to compare to", async () => {
    await seedOuting(db, { id: "solo", people: [lena], place: null, items: [["Toast", 1200, ["lena"]]], billDate: "2026-10-05" });
    const p = (await personProfile(db, G1, "lena", NOW))!;
    expect(p).toMatchObject({ outings: 1, spentCents: 1200, hosted: 0, frontedCents: 0, places: 0, favorite: null, companions: [] });
  });

  it("is null for someone who has only a draft here", async () => {
    await seedOuting(db, { id: "b1", people: [gavin], items: [["A", 500, ["gavin"]]], draft: true });
    expect(await personProfile(db, G1, "gavin", NOW)).toBeNull();
  });
});

describe("two servers", () => {
  async function both() {
    await seedOuting(db, { id: "a1", people: [gavin, marcus], place: "Saigon Kitchen", items: [["Pho", 2000, ["gavin"]], ["Bun", 2000, ["marcus"]]], billDate: "2026-10-05" });
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

  it("never mixes names, money, places or people", async () => {
    await both();
    const first = await serverBoards(db, G1, NOW);
    const second = await serverBoards(db, G2, NOW);

    expect(JSON.stringify(first)).not.toMatch(/Belayer|theo|9900/i);
    expect(JSON.stringify(second)).not.toMatch(/gavin|Saigon|"Marcus"/);

    const here = (await personProfile(db, G1, "marcus", NOW))!;
    expect(here).toMatchObject({ name: "Marcus", spentCents: 2000, outings: 1, places: 1 });
    expect(here.companions.map((c) => c.id)).toEqual(["gavin"]);
    expect(JSON.stringify(here)).not.toMatch(/Belayer|Crag|Theo/);
  });

  it("answers no bills for someone whose bills are all elsewhere", async () => {
    await both();
    expect(await personSummary(db, G1, "theo")).toBeNull();
    expect(await personProfile(db, G1, "theo", NOW)).toBeNull();
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
});
