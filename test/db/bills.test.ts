import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addClaim,
  addParticipant,
  bumpRevision,
  createBill,
  getBill,
  getBillItems,
  getParticipants,
  insertItems,
  openDraftInChannel,
  removeClaim,
  toSplitInput,
  type BillStatus,
  type NewBill,
} from "../../src/db/bills";
import { splitBill } from "../../src/money/split";
import { SAIGON } from "../fixtures/saigon";

const db = env.DB;

function newBill(id: string, overrides: Partial<NewBill> = {}): NewBill {
  return {
    id,
    guildId: "guild-1",
    channelId: "chan-1",
    messageId: null,
    payerId: "gavin",
    place: null,
    billDate: null,
    taxCents: 0,
    tipCents: 0,
    printedTotalCents: null,
    status: "draft",
    ...overrides,
  };
}

async function seedSaigon(billId: string) {
  await createBill(
    db,
    newBill(billId, { place: "Saigon Kitchen", taxCents: SAIGON.taxCents, tipCents: SAIGON.tipCents }),
  );
  // Insertion order differs from the sorted order the engine input uses, so
  // the test proves toSplitInput normalises rather than echoing storage.
  for (const id of [...SAIGON.participants].reverse()) {
    await addParticipant(db, { billId, id, kind: "member", displayName: id, addedBy: null });
  }
  await insertItems(
    db,
    billId,
    SAIGON.items.map(({ id, label, cents }) => ({ id, label, cents, source: "ocr", confidence: 0.9 })),
  );
  for (const item of SAIGON.items) {
    for (const who of item.claimedBy) await addClaim(db, billId, item.id, who);
  }
}

// Counts the statements a read sends to D1, since the free plan allows 50 per
// invocation and a query per item would blow it on a long receipt.
function counting(real: D1Database) {
  let prepared = 0;
  const wrapped = {
    prepare(sql: string) {
      prepared += 1;
      return real.prepare(sql);
    },
    batch: (statements: D1PreparedStatement[]) => real.batch(statements),
  } as unknown as D1Database;
  return { db: wrapped, count: () => prepared };
}

beforeEach(async () => {
  // Cascades through items, claims, participants, shares and settlements.
  await db.prepare("DELETE FROM bills").run();
});

describe("bill repository", () => {
  it("round-trips a bill and its items into split engine input", async () => {
    await seedSaigon("b-saigon");

    const input = await toSplitInput(db, "b-saigon");

    expect(input.items).toEqual(
      SAIGON.items.map((item) => ({ ...item, claimedBy: [...item.claimedBy].sort() })),
    );
    expect(input.participants).toEqual(SAIGON.participants);
    expect(input).toMatchObject({ taxCents: 2232, tipCents: 5030, payer: "gavin", pardoned: [] });

    const result = splitBill(input);
    const marcus = result.shares.find((s) => s.participant === "marcus");
    expect(marcus).toMatchObject({ owedCents: 4446, taxCents: 306, tipCents: 690 });
    expect(result).toEqual(splitBill(SAIGON));
  });

  it("returns items in receipt order with claimants in plain code-unit order", async () => {
    await createBill(db, newBill("b-order"));
    await insertItems(db, "b-order", [
      { id: "o-late", label: "Zucchini", cents: 100, source: "manual" },
      { id: "o-early", label: "Apple", cents: 200, source: "ocr", confidence: 0.4 },
    ]);
    await insertItems(db, "b-order", [{ id: "o-last", label: "Mango", cents: 300, source: "manual" }]);
    // "B" sorts before "a" by code unit; a locale-aware sort would flip them.
    for (const who of ["a", "B", "_", "1"]) {
      await addParticipant(db, { billId: "b-order", id: who, kind: "member", displayName: who, addedBy: null });
      await addClaim(db, "b-order", "o-late", who);
    }

    const items = await getBillItems(db, "b-order");

    expect(items.map((i) => i.id)).toEqual(["o-late", "o-early", "o-last"]);
    expect(items[0].claimedBy).toEqual(["1", "B", "_", "a"]);
    expect(items[1].claimedBy).toEqual([]);
  });

  it("keeps every read to a fixed number of statements however many items there are", async () => {
    await createBill(db, newBill("b-small"));
    await insertItems(db, "b-small", [{ id: "s-1", label: "One", cents: 100, source: "ocr" }]);
    await seedSaigon("b-big");

    const small = counting(db);
    await toSplitInput(small.db, "b-small");
    const big = counting(db);
    await toSplitInput(big.db, "b-big");

    expect(big.count()).toBe(small.count());
    expect(big.count()).toBeLessThanOrEqual(5);

    const items = counting(db);
    await getBillItems(items.db, "b-big");
    expect(items.count()).toBeLessThanOrEqual(2);
  });

  it("stores the source and confidence of an extracted line without treating them as money", async () => {
    await createBill(db, newBill("b-conf"));
    await insertItems(db, "b-conf", [
      { id: "c-1", label: "Smudged line", cents: 1250, source: "ocr", confidence: 0.42 },
      { id: "c-2", label: "Added by hand", cents: 500, source: "manual" },
    ]);

    const { results } = await db
      .prepare("SELECT id, source, confidence, position FROM bill_items WHERE bill_id = ? ORDER BY position")
      .bind("b-conf")
      .all();

    expect(results).toEqual([
      { id: "c-1", source: "ocr", confidence: 0.42, position: 0 },
      { id: "c-2", source: "manual", confidence: null, position: 1 },
    ]);
  });

  it("finds the one open draft in a channel and ignores confirmed bills", async () => {
    await createBill(db, newBill("b-old", { status: "confirmed" }));
    await createBill(db, newBill("b-other-chan", { channelId: "chan-2" }));
    expect(await openDraftInChannel(db, "chan-1")).toBeNull();

    await createBill(db, newBill("b-draft"));
    expect((await openDraftInChannel(db, "chan-1"))?.id).toBe("b-draft");
    expect((await openDraftInChannel(db, "chan-2"))?.id).toBe("b-other-chan");
  });

  it("treats a bill still being read as open, newest first, and skips closed statuses", async () => {
    await createBill(db, newBill("b-draft", { status: "draft" }));
    await createBill(db, newBill("b-reading", { status: "reading" }));
    expect((await openDraftInChannel(db, "chan-1"))?.id).toBe("b-reading");

    for (const status of ["confirmed", "superseded", "deleted"] as BillStatus[]) {
      await db.prepare("UPDATE bills SET status = ? WHERE channel_id = 'chan-1'").bind(status).run();
      expect(await openDraftInChannel(db, "chan-1")).toBeNull();
    }
  });

  it("reads a bill back as created, and null for an unknown id", async () => {
    const created = await createBill(
      db,
      newBill("b-1", { messageId: "m-1", place: "Pho 79", billDate: "2026-10-27", printedTotalCents: 6120 }),
    );

    expect(created).toMatchObject({ id: "b-1", revision: 1, confirmedAt: null, status: "draft" });
    expect(Date.parse(created.createdAt)).not.toBeNaN();
    expect(await getBill(db, "b-1")).toEqual(created);
    expect(await getBill(db, "nope")).toBeNull();
  });

  it("bumps the revision on every mutation", async () => {
    await createBill(db, newBill("b-rev"));
    const seen: number[] = [1];

    seen.push(await bumpRevision(db, "b-rev"));
    seen.push(await addParticipant(db, { billId: "b-rev", id: "dani", kind: "member", displayName: "Dani", addedBy: null }));
    seen.push(await insertItems(db, "b-rev", [{ id: "r-1", label: "Rolls", cents: 900, source: "ocr" }]));
    seen.push(await addClaim(db, "b-rev", "r-1", "dani"));
    seen.push(await removeClaim(db, "b-rev", "r-1", "dani"));

    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await getBill(db, "b-rev"))?.revision).toBe(6);
    await expect(bumpRevision(db, "missing")).rejects.toThrow(/missing/);
  });

  it("treats claiming twice as one claim and unclaiming as the inverse", async () => {
    await createBill(db, newBill("b-claim"));
    await addParticipant(db, { billId: "b-claim", id: "dani", kind: "member", displayName: "Dani", addedBy: null });
    await insertItems(db, "b-claim", [{ id: "k-1", label: "Rolls", cents: 900, source: "ocr" }]);

    await addClaim(db, "b-claim", "k-1", "dani");
    await addClaim(db, "b-claim", "k-1", "dani");
    expect((await getBillItems(db, "b-claim"))[0].claimedBy).toEqual(["dani"]);

    await removeClaim(db, "b-claim", "k-1", "dani");
    expect((await getBillItems(db, "b-claim"))[0].claimedBy).toEqual([]);
  });

  describe("claim writes stay inside their own bill", () => {
    async function twoBills() {
      for (const id of ["b-a", "b-b"]) {
        await createBill(db, newBill(id));
        await addParticipant(db, { billId: id, id: "dani", kind: "member", displayName: "Dani", addedBy: null });
      }
      await addParticipant(db, { billId: "b-b", id: "marcus", kind: "member", displayName: "Marcus", addedBy: null });
      await insertItems(db, "b-a", [{ id: "x-a", label: "A", cents: 100, source: "ocr" }]);
      await insertItems(db, "b-b", [{ id: "x-b", label: "B", cents: 100, source: "ocr" }]);
    }

    async function claimCount() {
      const row = await db.prepare("SELECT COUNT(*) AS n FROM item_claims").first<{ n: number }>();
      return row?.n;
    }

    it("refuses a claim on an unknown bill without writing it", async () => {
      await twoBills();

      await expect(addClaim(db, "ghost", "x-a", "dani")).rejects.toThrow(/ghost/);
      expect(await claimCount()).toBe(0);
    });

    it("refuses an item that belongs to another bill and leaves both revisions alone", async () => {
      await twoBills();

      await expect(addClaim(db, "b-a", "x-b", "dani")).rejects.toThrow(/x-b/);
      expect(await claimCount()).toBe(0);
      expect((await getBill(db, "b-a"))?.revision).toBe(3);
      expect((await getBill(db, "b-b"))?.revision).toBe(4);
    });

    it("refuses a claimant who is not a participant of that bill", async () => {
      await twoBills();

      await expect(addClaim(db, "b-a", "x-a", "marcus")).rejects.toThrow(/marcus/);
      expect(await claimCount()).toBe(0);
      expect((await toSplitInput(db, "b-a")).items[0].claimedBy).toEqual([]);
    });

    it("refuses to remove a claim through the wrong bill or an unknown one", async () => {
      await twoBills();
      await addClaim(db, "b-b", "x-b", "dani");

      await expect(removeClaim(db, "b-a", "x-b", "dani")).rejects.toThrow(/x-b/);
      await expect(removeClaim(db, "ghost", "x-b", "dani")).rejects.toThrow(/ghost/);
      expect(await claimCount()).toBe(1);
    });

    it("still removes a stale claim by someone no longer on the bill", async () => {
      await twoBills();
      await addClaim(db, "b-b", "x-b", "marcus");
      await db.prepare("DELETE FROM participants WHERE bill_id = 'b-b' AND id = 'marcus'").run();

      await removeClaim(db, "b-b", "x-b", "marcus");
      expect(await claimCount()).toBe(0);
    });
  });

  it("scopes a guest participant to its own bill", async () => {
    await createBill(db, newBill("b-one"));
    await createBill(db, newBill("b-two"));
    await addParticipant(db, { billId: "b-one", id: "dani", kind: "member", displayName: "Dani", addedBy: null });
    await addParticipant(db, { billId: "b-one", id: "guest-aaa", kind: "guest", displayName: "Sam", addedBy: "dani" });
    await addParticipant(db, { billId: "b-two", id: "guest-bbb", kind: "guest", displayName: "Sam", addedBy: "priya" });

    expect(await getParticipants(db, "b-one")).toEqual([
      { billId: "b-one", id: "dani", kind: "member", displayName: "Dani", addedBy: null },
      { billId: "b-one", id: "guest-aaa", kind: "guest", displayName: "Sam", addedBy: "dani" },
    ]);
    expect(await getParticipants(db, "b-two")).toEqual([
      { billId: "b-two", id: "guest-bbb", kind: "guest", displayName: "Sam", addedBy: "priya" },
    ]);
    expect((await toSplitInput(db, "b-two")).participants).toEqual(["guest-bbb"]);
  });

  it("refuses a guest nobody is billed for and a member billed to someone else", async () => {
    await createBill(db, newBill("b-bad"));

    await expect(
      addParticipant(db, { billId: "b-bad", id: "guest-x", kind: "guest", displayName: "Sam", addedBy: null }),
    ).rejects.toThrow();
    await expect(
      addParticipant(db, { billId: "b-bad", id: "dani", kind: "member", displayName: "Dani", addedBy: "gavin" }),
    ).rejects.toThrow();
  });

  it("rejects a status outside the lifecycle", async () => {
    await expect(createBill(db, newBill("b-status", { status: "reopened" as BillStatus }))).rejects.toThrow();
  });

  it("derives pardons from frozen share rows and has none while drafting", async () => {
    await seedSaigon("b-pardon");
    expect((await toSplitInput(db, "b-pardon")).pardoned).toEqual([]);

    const insertShare = db.prepare(
      `INSERT INTO shares (bill_id, participant_id, subtotal_cents, tax_cents, tip_cents, owed_cents, pardoned)
       VALUES (?, ?, 0, 0, 0, 0, ?)`,
    );
    await db.batch([
      insertShare.bind("b-pardon", "theo", 1),
      insertShare.bind("b-pardon", "jess", 0),
      insertShare.bind("b-pardon", "dani", 1),
    ]);

    expect((await toSplitInput(db, "b-pardon")).pardoned).toEqual(["dani", "theo"]);
  });

  it("keeps settlements and shares tied to a participant of the same bill", async () => {
    await createBill(db, newBill("b-fk"));
    await addParticipant(db, { billId: "b-fk", id: "dani", kind: "member", displayName: "Dani", addedBy: null });

    await expect(
      db
        .prepare(
          `INSERT INTO settlements (id, bill_id, participant_id, cents, recorded_at, recorded_by)
           VALUES ('s-1', 'b-fk', 'stranger', 500, '2026-10-28T00:00:00.000Z', 'stranger')`,
        )
        .run(),
    ).rejects.toThrow();
    await db
      .prepare(
        `INSERT INTO settlements (id, bill_id, participant_id, cents, recorded_at, recorded_by)
         VALUES ('s-2', 'b-fk', 'dani', 500, '2026-10-28T00:00:00.000Z', 'dani')`,
      )
      .run();
  });

  it("refuses to build split input for a bill that does not exist", async () => {
    await expect(toSplitInput(db, "ghost")).rejects.toThrow(/ghost/);
  });
});
