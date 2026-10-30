import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { BillNotConfirmedError, confirmBill, editItem, getBill, reopenBill, setBillAmounts } from "../../src/db/bills";
import {
  debts,
  outstanding,
  recordSettlement,
  SettlementGoneError,
  SettlementRefusedError,
  undoPaid,
  listSettlements,
} from "../../src/db/settlements";
import { seedSaigon } from "../fixtures/seed";

const db = env.DB;
const BILL = "bill-1";

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
});

async function confirmed(billId = BILL, payer = "gavin"): Promise<void> {
  const bill = (await getBill(db, billId))!;
  expect(await confirmBill(db, billId, bill.revision, payer)).toMatchObject({ ok: true });
}

async function owing(who: string, billId = BILL) {
  return (await outstanding(db, billId)).find((o) => o.participant === who);
}

async function settledAt(who: string, billId = BILL): Promise<string | null> {
  const row = await db
    .prepare("SELECT settled_at FROM shares WHERE bill_id = ? AND participant_id = ?")
    .bind(billId, who)
    .first<{ settled_at: string | null }>();
  return row!.settled_at;
}

async function refusal(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SettlementRefusedError);
  return (error as SettlementRefusedError).reason;
}

async function settlementCount(billId = BILL): Promise<number> {
  return (await listSettlements(db, billId)).length;
}

describe("recording a payment", () => {
  it("clears a share when settlements reach the owed amount", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    await recordSettlement(db, BILL, "marcus", 4000, "marcus");
    await recordSettlement(db, BILL, "marcus", 446, "marcus");

    expect(await owing("marcus")).toEqual({ participant: "marcus", owedCents: 4446, settledCents: 4446 });
    expect(await settledAt("marcus")).not.toBeNull();
  });

  it("tracks a partial payment against the remainder", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    await recordSettlement(db, BILL, "marcus", 4000, "marcus");

    const marcus = (await owing("marcus"))!;
    expect(marcus).toEqual({ participant: "marcus", owedCents: 4446, settledCents: 4000 });
    expect(marcus.owedCents - marcus.settledCents).toBe(446);
    expect(await settledAt("marcus")).toBeNull();
  });

  it("lets the payer undo someone's paid, every payment of theirs at once", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    // Two rows, the way a part payment made before paid was yes or no left it.
    await recordSettlement(db, BILL, "marcus", 4000, "marcus");
    await recordSettlement(db, BILL, "marcus", 446, "marcus");
    await recordSettlement(db, BILL, "jess", 100, "jess");
    const [payment] = await listSettlements(db, BILL);
    expect(payment).toMatchObject({ billId: BILL, participant: "jess", cents: 100, recordedBy: "jess" });

    expect(await undoPaid(db, BILL, "marcus")).toBe(4446);

    expect(await owing("marcus")).toEqual({ participant: "marcus", owedCents: 4446, settledCents: 0 });
    expect(await settlementCount()).toBe(1);
    expect(await settledAt("marcus")).toBeNull();
    await expect(undoPaid(db, BILL, "marcus")).rejects.toThrow(SettlementGoneError);
  });

  it("refuses a settlement recorded for someone else by a non-payer", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    expect(await refusal(recordSettlement(db, BILL, "marcus", 4446, "jess"))).toBe("not-allowed");
    expect(await settlementCount()).toBe(0);

    // The payer can: Marcus handed over cash.
    await recordSettlement(db, BILL, "marcus", 4446, "gavin");
    expect(await listSettlements(db, BILL)).toMatchObject([{ participant: "marcus", cents: 4446, recordedBy: "gavin" }]);
  });

  it("refuses a paid-it-all that was drawn from a remaining amount that has since changed", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 4446, "marcus", { remainingCents: 4446 });
    expect(await settledAt("marcus")).not.toBeNull();

    // The same button tapped twice: the second tap still says 4446.
    expect(await refusal(recordSettlement(db, BILL, "marcus", 4446, "marcus", { remainingCents: 4446 }))).toBe("clear");

    await recordSettlement(db, BILL, "jess", 1000, "jess");
    // A prompt drawn before the 10.00 partial, now worth less than it says.
    expect(await refusal(recordSettlement(db, BILL, "jess", 3382, "jess", { remainingCents: 4382 }))).toBe("stale");
    expect((await owing("jess"))!.settledCents).toBe(1000);
  });

  it("refuses an amount over what is left, and an amount of zero or less", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 4000, "marcus");

    expect(await refusal(recordSettlement(db, BILL, "marcus", 447, "marcus"))).toBe("over");
    expect(await refusal(recordSettlement(db, BILL, "marcus", 0, "marcus"))).toBe("not-positive");
    expect(await refusal(recordSettlement(db, BILL, "marcus", -100, "marcus"))).toBe("not-positive");
    expect((await owing("marcus"))!.settledCents).toBe(4000);

    await recordSettlement(db, BILL, "marcus", 446, "marcus");
    expect((await owing("marcus"))!.settledCents).toBe(4446);
  });

  it("refuses a payment on the payer's own share, whoever records it", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    expect(await refusal(recordSettlement(db, BILL, "gavin", 4833, "gavin"))).toBe("payer");
    expect(await refusal(recordSettlement(db, BILL, "gavin", 100, "marcus"))).toBe("not-allowed");
    expect(await settlementCount()).toBe(0);
    expect((await outstanding(db, BILL)).map((o) => o.participant)).not.toContain("gavin");
  });

  it("refuses a payment on a draft bill and on a reopened one", async () => {
    await seedSaigon(db, BILL);

    expect(await refusal(recordSettlement(db, BILL, "marcus", 4446, "marcus"))).toBe("not-confirmed");

    await confirmed();
    await reopenBill(db, BILL);
    expect(await refusal(recordSettlement(db, BILL, "marcus", 4446, "marcus"))).toBe("not-confirmed");
    expect(await refusal(recordSettlement(db, BILL, "marcus", 4446, "gavin"))).toBe("not-confirmed");
    expect(await settlementCount()).toBe(0);
  });

  it("refuses an undo once the bill is no longer confirmed, and keeps the payment", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 4446, "marcus");
    await reopenBill(db, BILL);

    await expect(undoPaid(db, BILL, "marcus")).rejects.toThrow(BillNotConfirmedError);
    expect(await settlementCount()).toBe(1);
  });
});

describe("settled_at", () => {
  it("is set when payments first reach the amount and cleared when an undo drops below it", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    await recordSettlement(db, BILL, "marcus", 4000, "marcus");
    expect(await settledAt("marcus")).toBeNull();
    await recordSettlement(db, BILL, "marcus", 446, "marcus");
    const first = await settledAt("marcus");
    expect(first).not.toBeNull();

    await undoPaid(db, BILL, "marcus");
    expect(await settledAt("marcus")).toBeNull();

    await recordSettlement(db, BILL, "marcus", 4446, "marcus");
    expect(await settledAt("marcus")).not.toBeNull();
    // Nobody else moved.
    expect(await settledAt("jess")).toBeNull();
    expect(await settledAt("gavin")).toBeNull();
  });

  it("keeps the timestamp through a re-confirm that leaves the person clear, and clears it when they owe more", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 4446, "marcus");
    const clearedAt = await settledAt("marcus");
    expect(clearedAt).not.toBeNull();

    // Spring rolls were $6.42: Marcus now owes 41.10 and has paid 44.46.
    await reopenBill(db, BILL);
    await editItem(db, BILL, `${BILL}-rolls`, { baseCents: 642 });
    await setBillAmounts(db, BILL, { printedTotalCents: 24292 + 2232 });
    await confirmed();
    expect((await owing("marcus"))!.owedCents).toBe(4110);
    expect(await settledAt("marcus")).toBe(clearedAt);

    // Then $21.00: Marcus owes more than he paid.
    await reopenBill(db, BILL);
    await editItem(db, BILL, `${BILL}-rolls`, { baseCents: 2100 });
    await setBillAmounts(db, BILL, { printedTotalCents: 25750 + 2232 });
    await confirmed();
    expect((await owing("marcus"))!.owedCents).toBeGreaterThan(4446);
    expect(await settledAt("marcus")).toBeNull();
  });

  it("is set by a re-confirm that brings someone's amount down to what they already paid", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 4110, "marcus");
    expect(await settledAt("marcus")).toBeNull();

    await reopenBill(db, BILL);
    await editItem(db, BILL, `${BILL}-rolls`, { baseCents: 642 });
    await setBillAmounts(db, BILL, { printedTotalCents: 24292 + 2232 });
    await confirmed();

    expect(await owing("marcus")).toEqual({ participant: "marcus", owedCents: 4110, settledCents: 4110 });
    expect(await settledAt("marcus")).not.toBeNull();
  });
});

describe("pardons", () => {
  it("excludes a pardoned share from what the payer is owed", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await db.prepare("UPDATE shares SET pardoned = 1 WHERE bill_id = ? AND participant_id = 'marcus'").bind(BILL).run();

    expect(await owing("marcus")).toEqual({ participant: "marcus", owedCents: 0, settledCents: 0 });
    const rows = await debts(db, "gavin");
    expect(rows.map((r) => r.debtor)).not.toContain("marcus");
    expect(rows.reduce((sum, r) => sum + r.owedCents - r.settledCents, 0)).toBe(27579 - 4446);
    expect(await refusal(recordSettlement(db, BILL, "marcus", 100, "marcus"))).toBe("clear");
  });
});

describe("debts", () => {
  it("lists each bill's debt both ways round, and scopes it to one server", async () => {
    await seedSaigon(db, BILL);
    await seedSaigon(db, "bill-2", { bill: { guildId: "guild-2", channelId: "chan-2", messageId: "msg-2" } });
    // Marcus paid for this one, so Gavin owes on it instead of collecting.
    await seedSaigon(db, "bill-3", { bill: { payerId: "marcus", channelId: "chan-3", messageId: "msg-3" } });
    // A draft owes nobody anything yet.
    await seedSaigon(db, "bill-4", { bill: { channelId: "chan-4", messageId: "msg-4" } });
    await confirmed(BILL);
    await confirmed("bill-2");
    await confirmed("bill-3", "marcus");
    await recordSettlement(db, BILL, "marcus", 4000, "marcus");
    await recordSettlement(db, "bill-2", "priya", 5091, "priya");

    const here = await debts(db, "gavin", "guild-1");
    const everywhere = await debts(db, "gavin");

    expect(here.find((r) => r.debtor === "marcus" && r.billId === BILL)).toEqual({
      billId: BILL,
      place: "Saigon Kitchen",
      date: "2026-10-28",
      payer: "gavin",
      payerName: "Gavin",
      debtor: "marcus",
      debtorName: "Marcus",
      debtorKind: "member",
      owedCents: 4446,
      settledCents: 4000,
    });
    expect(here.find((r) => r.debtor === "gavin")).toMatchObject({ billId: "bill-3", payer: "marcus", payerName: "Marcus" });
    expect(here.filter((r) => r.payer === "gavin").map((r) => r.debtor).sort()).toEqual(["dani", "jess", "lena", "marcus", "omar", "priya", "theo"]);

    expect(everywhere.filter((r) => r.debtor === "marcus").map((r) => r.billId).sort()).toEqual([BILL, "bill-2"]);
    // Priya cleared the second bill, so only the first still counts.
    expect(everywhere.filter((r) => r.debtor === "priya").map((r) => r.billId)).toEqual([BILL]);
    expect(everywhere.filter((r) => r.billId === "bill-4")).toEqual([]);

    // Marcus's view is the same rows from the other side.
    expect((await debts(db, "marcus")).find((r) => r.billId === BILL)).toMatchObject({ debtor: "marcus", payer: "gavin" });
    expect(await debts(db, "gavin", "guild-9")).toEqual([]);
  });

  it("leaves a reopened bill out both ways until it is confirmed again", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    const before = await debts(db, "gavin");
    expect(before.length).toBeGreaterThan(0);
    expect(await debts(db, "marcus")).toHaveLength(1);

    await reopenBill(db, BILL);
    expect(await debts(db, "gavin")).toEqual([]);
    expect(await debts(db, "marcus")).toEqual([]);

    await confirmed();
    expect(await debts(db, "gavin")).toEqual(before);
    expect(await debts(db, "marcus")).toHaveLength(1);
  });

  it("falls back to the day the bill was made when no date was printed", async () => {
    await seedSaigon(db, BILL, { bill: { billDate: null } });
    await confirmed();

    expect((await debts(db, "gavin"))[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("puts the newest bill first", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await seedSaigon(db, "bill-2", { bill: { channelId: "chan-2", messageId: "msg-2" } });
    await db.prepare("UPDATE participants SET display_name = 'Marcus T' WHERE bill_id = 'bill-2' AND id = 'marcus'").run();
    await confirmed("bill-2");

    const marcus = (await debts(db, "gavin", "guild-1")).filter((r) => r.debtor === "marcus");

    expect(marcus.map((r) => r.debtorName)).toEqual(["Marcus T", "Marcus"]);
  });
});
