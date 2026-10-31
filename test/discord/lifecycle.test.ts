import { env as workerEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BillChangedError,
  BillNotDraftError,
  confirmBill,
  deleteBill,
  getBill,
  getBillItems,
  NobodyClaimedError,
  NotOnRosterError,
  PaymentsChangedError,
  PaymentsRecordedError,
  reassignPayer,
  reopenBill,
  setClaim,
  setPardon,
  splitOrphansEvenly,
  toSplitInput,
} from "../../src/db/bills";
import { loadBillMessage } from "../../src/discord/render";
import { splitBill } from "../../src/money/split";
import type { Share } from "../../src/money/types";
import { beforeFirstWrite, confirmingBeforeFirstWrite } from "../fixtures/race";
import { SAIGON } from "../fixtures/saigon";
import { seedSaigon } from "../fixtures/seed";

const db = workerEnv.DB;
const BILL = "bill-1";

const item = (id: string) => `${BILL}-${id}`;

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
});

function shown(data: any): string {
  return [data.content ?? "", ...(data.embeds ?? []).map((e: any) => JSON.stringify(e))].join("\n");
}

async function revision(billId = BILL): Promise<number> {
  return (await getBill(db, billId))!.revision;
}

async function frozenShares(billId = BILL): Promise<Share[]> {
  const { results } = await db
    .prepare(
      `SELECT participant_id, subtotal_cents, discount_cents, tax_cents, tip_cents, owed_cents, pardoned
       FROM shares WHERE bill_id = ? ORDER BY participant_id`,
    )
    .bind(billId)
    .all<any>();
  return results.map((r) => ({
    participant: r.participant_id,
    subtotalCents: r.subtotal_cents,
    discountCents: r.discount_cents,
    taxCents: r.tax_cents,
    tipCents: r.tip_cents,
    owedCents: r.owed_cents,
    pardoned: r.pardoned === 1,
  }));
}

async function pay(who: string, cents: number, database: D1Database = db): Promise<void> {
  await database
    .prepare(
      "INSERT INTO settlements (id, bill_id, participant_id, cents, recorded_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), BILL, who, cents, "2026-10-29T09:00:00.000Z", who)
    .run();
}

async function confirmed(billId = BILL): Promise<void> {
  expect(await confirmBill(db, billId, await revision(billId), "gavin")).toMatchObject({ ok: true });
}

// Spring rolls were really $6.42, not $15.00: the correction that takes
// Marcus from $44.46 to $41.10. Written straight to D1, the way P10 models a
// correction landing on a frozen bill.
async function correctRollsBehindTheBillsBack(): Promise<void> {
  await db.prepare("UPDATE bill_items SET cents = 642 WHERE id = ?").bind(item("rolls")).run();
}

describe("confirmBill", () => {
  it("refuses to confirm a bill that does not reconcile", async () => {
    await seedSaigon(db, BILL, { bill: { printedTotalCents: 27000 } });

    expect(await confirmBill(db, BILL, await revision(), "gavin")).toEqual({ ok: false, reason: "unreconciled" });
    expect((await getBill(db, BILL))!.status).toBe("draft");
    expect(await frozenShares()).toEqual([]);
  });

  it("refuses to confirm when the bill changed since the payer's view", async () => {
    await seedSaigon(db, BILL);
    const seen = await revision();
    await setClaim(db, BILL, item("tea"), "gavin", true);

    expect(await confirmBill(db, BILL, seen, "gavin")).toEqual({ ok: false, reason: "stale" });
    expect((await getBill(db, BILL))!.status).toBe("draft");
    expect(await frozenShares()).toEqual([]);
  });

  it("refuses to confirm for anyone but the payer", async () => {
    await seedSaigon(db, BILL);

    expect(await confirmBill(db, BILL, await revision(), "marcus")).toEqual({ ok: false, reason: "not-payer" });
    expect((await getBill(db, BILL))!.status).toBe("draft");
    expect(await frozenShares()).toEqual([]);
  });

  it("refuses to confirm while a line has nobody on it", async () => {
    await seedSaigon(db, BILL, { unclaimed: ["tea"] });

    expect(await confirmBill(db, BILL, await revision(), "gavin")).toEqual({ ok: false, reason: "unclaimed" });
    expect((await getBill(db, BILL))!.status).toBe("draft");
    expect(await frozenShares()).toEqual([]);
  });

  it("refuses to confirm a bill that is not a draft", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    expect(await confirmBill(db, BILL, await revision(), "gavin")).toEqual({ ok: false, reason: "not-draft" });
    expect(await confirmBill(db, "no-such-bill", 1, "gavin")).toEqual({ ok: false, reason: "not-draft" });
  });

  it("freezes the shares at confirm", async () => {
    await seedSaigon(db, BILL);
    const before = await revision();

    expect(await confirmBill(db, BILL, before, "gavin")).toEqual({ ok: true, changes: [], removedLogs: [] });

    const bill = (await getBill(db, BILL))!;
    expect(bill.status).toBe("confirmed");
    expect(bill.confirmedAt).not.toBeNull();
    expect(bill.revision).toBe(before + 1);
    const frozen = await frozenShares();
    expect(frozen).toEqual(splitBill(SAIGON).shares);
    expect(frozen.find((s) => s.participant === "marcus")!.owedCents).toBe(4446);
    expect(frozen.reduce((sum, s) => sum + s.owedCents, 0)).toBe(32412);

    // A later change to the lines moves nothing that was frozen, and the
    // message keeps showing the frozen number.
    await correctRollsBehindTheBillsBack();
    expect(await frozenShares()).toEqual(frozen);
    const message = await loadBillMessage(db, BILL);
    expect(shown(message!.data)).toMatch(/<@marcus>[^\\"]*\$44\.46/);
    expect(shown(message!.data)).not.toContain("$41.10");
  });

  it("freezes nothing when a write lands between its read and its freeze", async () => {
    await seedSaigon(db, BILL);
    const seen = await revision();
    // Dani takes her noodles back after Confirm has read the bill.
    const race = beforeFirstWrite(db, (real) => setClaim(real, BILL, item("noodles"), "dani", false));

    expect(await confirmBill(race.db, BILL, seen, "gavin")).toEqual({ ok: false, reason: "stale" });

    expect(race.raced()).toBe(true);
    const bill = (await getBill(db, BILL))!;
    expect(bill.status).toBe("draft");
    expect(bill.confirmedAt).toBeNull();
    expect(bill.revision).toBe(seen + 1);
    expect(await frozenShares()).toEqual([]);
  });

  it("freezes nothing when another Confirm wins the race", async () => {
    await seedSaigon(db, BILL);
    const race = confirmingBeforeFirstWrite(db, BILL);

    expect(await confirmBill(race.db, BILL, await revision(), "gavin")).toEqual({ ok: false, reason: "not-draft" });

    expect(race.raced()).toBe(true);
    expect(await frozenShares()).toEqual([]);
  });
});

describe("splitOrphansEvenly", () => {
  it("offers to split orphan lines evenly and then confirms", async () => {
    // Zoe is on the bill but has claimed nothing, so she takes no share of
    // the orphans.
    await seedSaigon(db, BILL, { participants: [...SAIGON.participants, "zoe"], unclaimed: ["tea", "water"] });
    const seen = await revision();
    expect(await confirmBill(db, BILL, seen, "gavin")).toEqual({ ok: false, reason: "unclaimed" });

    const now = await splitOrphansEvenly(db, BILL, { revision: seen });

    expect(now).toBe(seen + 1);
    const items = await getBillItems(db, BILL);
    const everyoneButZoe = [...SAIGON.participants].sort();
    expect(items.find((i) => i.id === item("tea"))!.claimedBy).toEqual(everyoneButZoe);
    expect(items.find((i) => i.id === item("water"))!.claimedBy).toEqual(everyoneButZoe);
    expect(items.find((i) => i.id === item("noodles"))!.claimedBy).toEqual(["dani"]);

    expect(await confirmBill(db, BILL, now, "gavin")).toEqual({ ok: true, changes: [], removedLogs: [] });
    const frozen = await frozenShares();
    expect(frozen.reduce((sum, s) => sum + s.owedCents, 0)).toBe(32412);
    expect(frozen.find((s) => s.participant === "zoe")!.owedCents).toBe(0);
  });

  it("refuses when nobody has claimed anything yet", async () => {
    await seedSaigon(db, BILL, { unclaimed: SAIGON.items.map((i) => i.id) });
    const before = await revision();

    await expect(splitOrphansEvenly(db, BILL, { revision: before })).rejects.toBeInstanceOf(NobodyClaimedError);

    expect((await getBillItems(db, BILL)).every((i) => i.claimedBy.length === 0)).toBe(true);
    expect(await revision()).toBe(before);
  });

  it("splits nothing on a bill that changed since the offer", async () => {
    await seedSaigon(db, BILL, { unclaimed: ["tea", "water"] });
    const offered = await revision();
    await setClaim(db, BILL, item("tea"), "jess", true);

    await expect(splitOrphansEvenly(db, BILL, { revision: offered })).rejects.toBeInstanceOf(BillChangedError);

    const items = await getBillItems(db, BILL);
    expect(items.find((i) => i.id === item("tea"))!.claimedBy).toEqual(["jess"]);
    expect(items.find((i) => i.id === item("water"))!.claimedBy).toEqual([]);
    expect(await revision()).toBe(offered + 1);
  });
});

describe("reopenBill", () => {
  it("reports every amount change when reopening a bill someone paid", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await pay("marcus", 4000);
    await pay("marcus", 446);
    await correctRollsBehindTheBillsBack();

    expect(await reopenBill(db, BILL)).toEqual([
      { participant: "marcus", wasCents: 4446, nowCents: 4110, settledCents: 4446 },
    ]);
  });

  it("keeps claims intact across a reopen", async () => {
    await seedSaigon(db, BILL);
    const claims = await getBillItems(db, BILL);
    await confirmed();
    const frozen = await frozenShares();
    const confirmedRevision = await revision();
    const { confirmedAt } = (await getBill(db, BILL))!;

    expect(await reopenBill(db, BILL)).toEqual([]);

    const bill = (await getBill(db, BILL))!;
    expect(bill.status).toBe("draft");
    expect(bill.revision).toBe(confirmedRevision + 1);
    // Still marked as once confirmed, so a /split never supersedes it.
    expect(bill.confirmedAt).toBe(confirmedAt);
    expect(await getBillItems(db, BILL)).toEqual(claims);
    // The share rows stay, so a re-confirm keeps their pardon flags.
    expect(await frozenShares()).toEqual(frozen);

    // And it can be confirmed again as it stands.
    expect(await confirmBill(db, BILL, bill.revision, "gavin")).toEqual({ ok: true, changes: [], removedLogs: [] });
  });

  it("refuses to reopen a bill that is not confirmed", async () => {
    await seedSaigon(db, BILL);
    const before = await revision();

    await expect(reopenBill(db, BILL)).rejects.toThrow(/not confirmed/);
    expect(await revision()).toBe(before);
  });
});

describe("reassignPayer", () => {
  it("reassigns the payer to another member of the roster", async () => {
    await seedSaigon(db, BILL);
    // somebody else's card went down, so the invoker is not the payer
    await reassignPayer(db, BILL, "priya");
    const r = splitBill(await toSplitInput(db, BILL));
    expect(r.payerCollectsCents).toBe(32412 - 5091);
  });

  it("drops the old payer's pardons when a reopened bill changes hands", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await setPardon(db, BILL, "lena", true);
    await reopenBill(db, BILL);

    await reassignPayer(db, BILL, "priya");
    expect(await confirmBill(db, BILL, await revision(), "priya")).toMatchObject({ ok: true });

    const r = splitBill(await toSplitInput(db, BILL));
    expect(r.shares.some((s) => s.pardoned)).toBe(false);
    expect(r.payerCollectsCents).toBe(32412 - 5091);
  });

  it("keeps pardons when the payer is handed back to themselves", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await setPardon(db, BILL, "lena", true);
    await reopenBill(db, BILL);

    await reassignPayer(db, BILL, "gavin");

    expect(splitBill(await toSplitInput(db, BILL)).shares.find((s) => s.participant === "lena")!.pardoned).toBe(true);
  });

  it("refuses to reassign the payer to someone off the roster", async () => {
    await seedSaigon(db, BILL);
    const before = await revision();

    await expect(reassignPayer(db, BILL, "zoe")).rejects.toBeInstanceOf(NotOnRosterError);

    expect((await getBill(db, BILL))!.payerId).toBe("gavin");
    expect(await revision()).toBe(before);
  });

  it("refuses to reassign the payer once the bill is confirmed", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    await expect(reassignPayer(db, BILL, "priya")).rejects.toBeInstanceOf(BillNotDraftError);
    expect((await getBill(db, BILL))!.payerId).toBe("gavin");
  });

  it("refuses to reassign the payer of a reopened bill someone has paid, so no payment is redirected", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await pay("marcus", 4446);
    await reopenBill(db, BILL);
    const before = await revision();

    await expect(reassignPayer(db, BILL, "priya")).rejects.toBeInstanceOf(PaymentsRecordedError);

    expect((await getBill(db, BILL))!.payerId).toBe("gavin");
    expect(await revision()).toBe(before);
  });

  it("refuses to reassign the payer when a payment lands between its check and its write", async () => {
    await seedSaigon(db, BILL);
    const before = await revision();
    const race = beforeFirstWrite(db, (real) => pay("marcus", 4446, real));

    await expect(reassignPayer(race.db, BILL, "priya")).rejects.toBeInstanceOf(PaymentsRecordedError);

    expect(race.raced()).toBe(true);
    expect((await getBill(db, BILL))!.payerId).toBe("gavin");
    expect(await revision()).toBe(before);
  });
});

describe("deleteBill", () => {
  it("deletes nothing when a payment lands just before the delete is written", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    const before = await revision();
    const race = beforeFirstWrite(db, (real) => pay("marcus", 4446, real));

    await expect(deleteBill(race.db, BILL, 0)).rejects.toBeInstanceOf(PaymentsChangedError);

    expect(race.raced()).toBe(true);
    expect((await getBill(db, BILL))!.status).toBe("confirmed");
    expect(await revision()).toBe(before);
  });
});
