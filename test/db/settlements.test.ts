import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { confirmBill, editItem, getBill, reopenBill, setBillAmounts } from "../../src/db/bills";
import {
  ledger,
  outstanding,
  recordSettlement,
  SettlementRefusedError,
  undoSettlement,
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

  it("lets the payer undo a settlement", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 4446, "marcus");
    const [payment] = await listSettlements(db, BILL);
    expect(payment).toMatchObject({ billId: BILL, participant: "marcus", cents: 4446, recordedBy: "marcus" });

    await undoSettlement(db, payment!.id);

    expect(await owing("marcus")).toEqual({ participant: "marcus", owedCents: 4446, settledCents: 0 });
    expect(await settlementCount()).toBe(0);
    expect(await settledAt("marcus")).toBeNull();
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
    const [payment] = await listSettlements(db, BILL);
    await reopenBill(db, BILL);

    await expect(undoSettlement(db, payment!.id)).rejects.toThrow();
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

    const payments = await listSettlements(db, BILL);
    const small = payments.find((p) => p.cents === 446)!;
    await undoSettlement(db, small.id);
    expect(await settledAt("marcus")).toBeNull();

    await recordSettlement(db, BILL, "marcus", 446, "marcus");
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
    await editItem(db, BILL, `${BILL}-rolls`, { cents: 642 });
    await setBillAmounts(db, BILL, { printedTotalCents: 24292 + 2232 });
    await confirmed();
    expect((await owing("marcus"))!.owedCents).toBe(4110);
    expect(await settledAt("marcus")).toBe(clearedAt);

    // Then $21.00: Marcus owes more than he paid.
    await reopenBill(db, BILL);
    await editItem(db, BILL, `${BILL}-rolls`, { cents: 2100 });
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
    await editItem(db, BILL, `${BILL}-rolls`, { cents: 642 });
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
    const rows = await ledger(db, "gavin");
    expect(rows.map((r) => r.participant)).not.toContain("marcus");
    expect(rows.reduce((sum, r) => sum + r.owedCents - r.settledCents, 0)).toBe(27579 - 4446);
    expect(await refusal(recordSettlement(db, BILL, "marcus", 100, "marcus"))).toBe("clear");
  });
});

describe("ledger", () => {
  it("rolls the ledger up across servers and scopes it to one", async () => {
    await seedSaigon(db, BILL);
    await seedSaigon(db, "bill-2", { bill: { guildId: "guild-2", channelId: "chan-2", messageId: "msg-2" } });
    // Marcus paid for this one, so what Gavin owes on it is not Gavin's to collect.
    await seedSaigon(db, "bill-3", { bill: { payerId: "marcus", channelId: "chan-3", messageId: "msg-3" } });
    // A draft owes nobody anything yet.
    await seedSaigon(db, "bill-4", { bill: { channelId: "chan-4", messageId: "msg-4" } });
    await confirmed(BILL);
    await confirmed("bill-2");
    await confirmed("bill-3", "marcus");
    await recordSettlement(db, BILL, "marcus", 4000, "marcus");
    await recordSettlement(db, "bill-2", "priya", 5091, "priya");

    const here = await ledger(db, "gavin", "guild-1");
    const everywhere = await ledger(db, "gavin");

    expect(here.find((r) => r.participant === "marcus")).toEqual({
      participant: "marcus",
      displayName: "Marcus",
      kind: "member",
      place: "Saigon Kitchen",
      owedCents: 4446,
      settledCents: 4000,
      billCount: 1,
    });
    expect(here.find((r) => r.participant === "priya")).toMatchObject({ owedCents: 5091, settledCents: 0, billCount: 1 });
    expect(here.map((r) => r.participant).sort()).toEqual(["dani", "jess", "lena", "marcus", "omar", "priya", "theo"]);

    expect(everywhere.find((r) => r.participant === "marcus")).toEqual({
      participant: "marcus",
      displayName: "Marcus",
      kind: "member",
      place: "Saigon Kitchen",
      owedCents: 8892,
      settledCents: 4000,
      billCount: 2,
    });
    // Priya cleared the second bill, so only the first still counts.
    expect(everywhere.find((r) => r.participant === "priya")).toMatchObject({ owedCents: 5091, settledCents: 0, billCount: 1 });
    expect(everywhere.find((r) => r.participant === "dani")).toMatchObject({ owedCents: 9536, billCount: 2 });
    expect(everywhere.map((r) => r.participant)).not.toContain("gavin");

    // Who owes Marcus is a separate view over the same rows.
    expect((await ledger(db, "marcus")).map((r) => r.participant)).toContain("gavin");
    expect(await ledger(db, "gavin", "guild-9")).toEqual([]);
  });

  it("puts whoever owes the most first and names them as they appear on the latest bill", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await seedSaigon(db, "bill-2", { bill: { channelId: "chan-2", messageId: "msg-2" } });
    await db.prepare("UPDATE participants SET display_name = 'Marcus T' WHERE bill_id = 'bill-2' AND id = 'marcus'").run();
    await confirmed("bill-2");

    const rows = await ledger(db, "gavin", "guild-1");

    const remaining = rows.map((r) => r.owedCents - r.settledCents);
    expect(remaining).toEqual([...remaining].sort((a, b) => b - a));
    expect(rows[0]!.participant).toBe("priya");
    expect(rows.find((r) => r.participant === "marcus")!.displayName).toBe("Marcus T");
  });
});
