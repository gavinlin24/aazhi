import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import {
  BillChangedError,
  BillNotDraftError,
  confirmBill,
  deleteBill,
  editItem,
  getBill,
  getBillItems,
  NobodyClaimedError,
  NotOnRosterError,
  PaymentsChangedError,
  PaymentsRecordedError,
  reassignPayer,
  reopenBill,
  setBillAmounts,
  setClaim,
  splitOrphansEvenly,
  toSplitInput,
} from "../../src/db/bills";
import { loadBillMessage } from "../../src/discord/render";
import type { Env } from "../../src/env";
import { formatCents } from "../../src/format";
import { splitBill } from "../../src/money/split";
import type { Share } from "../../src/money/types";
import { beforeFirstWrite, confirmingBeforeFirstWrite } from "../fixtures/race";
import { SAIGON } from "../fixtures/saigon";
import { seedSaigon } from "../fixtures/seed";
import { generateKeypair, signedRequest, testEnv, type TestKeypair } from "./helpers";

const db = workerEnv.DB;
const BILL = "bill-1";
const API = "https://discord.com/api/v10";
const APP_ID = "app-1";
const TOKEN = "interaction-token";
const EPHEMERAL = 1 << 6;

const item = (id: string) => `${BILL}-${id}`;

let keypair: TestKeypair;
const ready = generateKeypair().then((k) => (keypair = k));

function env(): Env {
  return { ...testEnv(keypair.publicKeyHex), DISCORD_BOT_TOKEN: "bot-token", DISCORD_APPLICATION_ID: APP_ID, TOKEN_SIGNING_KEY: "k" };
}

let calls: { url: string; method: string; body: any }[];

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
  calls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const channel = /\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(url);
    return Response.json(channel ? { id: channel[2], channel_id: channel[1] } : { id: "follow-up-1", channel_id: "chan-1" });
  });
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// The message edit waits out its coalescing window on a timer; advancing fake
// time lets it finish without the test sleeping for real.
async function settle(work: Promise<unknown>): Promise<void> {
  let done = false;
  const finished = work.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; !done; i++) {
    if (i > 200) throw new Error("background work never finished");
    await vi.advanceTimersByTimeAsync(500);
  }
  await finished;
}

async function run(body: unknown, database: D1Database = db): Promise<any> {
  await ready;
  const ctx = createExecutionContext();
  const response = await app.fetch(await signedRequest(keypair, body), { ...env(), DB: database }, ctx);
  await settle(waitOnExecutionContext(ctx));
  return response.json();
}

function member(id: string, nick: string) {
  return {
    user: { id, username: `${id}_user`, global_name: null, discriminator: "0", avatar: null },
    nick,
    roles: [],
    joined_at: "2020-01-01T00:00:00.000Z",
    deaf: false,
    mute: false,
    flags: 0,
    permissions: "0",
  };
}

const GAVIN = member("gavin", "Gavin");
const MARCUS = member("marcus", "Marcus");

function tap(customId: string, who: unknown) {
  return {
    id: "int-1",
    application_id: APP_ID,
    type: 3,
    token: TOKEN,
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    channel: { id: "chan-1", type: 0 },
    member: who,
    message: { id: "msg-1", channel_id: "chan-1" },
    data: { custom_id: customId, component_type: 2 },
  };
}

function messageEdits() {
  return calls.filter((c) => c.url === `${API}/channels/chan-1/messages/msg-1`);
}

function followUps() {
  return calls.filter((c) => c.url === `${API}/webhooks/${APP_ID}/${TOKEN}` && c.method === "POST");
}

function customIds(data: any): string[] {
  return ((data.components ?? []) as any[]).flatMap((row) => row.components.map((c: any) => c.custom_id));
}

function shown(data: any): string {
  return [data.content ?? "", ...(data.embeds ?? []).map((e: any) => JSON.stringify(e))].join("\n");
}

async function revision(billId = BILL): Promise<number> {
  return (await getBill(db, billId))!.revision;
}

async function frozenShares(billId = BILL): Promise<Share[]> {
  const { results } = await db
    .prepare(
      `SELECT participant_id, subtotal_cents, tax_cents, tip_cents, owed_cents, pardoned
       FROM shares WHERE bill_id = ? ORDER BY participant_id`,
    )
    .bind(billId)
    .all<any>();
  return results.map((r) => ({
    participant: r.participant_id,
    subtotalCents: r.subtotal_cents,
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

// Message edits are coalesced on D1's real clock, which fake timers do not
// move; a test that taps several times clears the window to see the last edit.
async function expireEditLease(billId = BILL): Promise<void> {
  await db.prepare("UPDATE bills SET edit_lease_until = NULL WHERE id = ?").bind(billId).run();
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

    expect(await confirmBill(db, BILL, before, "gavin")).toEqual({ ok: true, changes: [] });

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

    expect(await confirmBill(db, BILL, now, "gavin")).toEqual({ ok: true, changes: [] });
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
    expect(await confirmBill(db, BILL, bill.revision, "gavin")).toEqual({ ok: true, changes: [] });
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

describe("Confirm", () => {
  it("locks the bill from its message and shows the frozen shares", async () => {
    await seedSaigon(db, BILL);
    const seen = await revision();

    const reply = await run(tap(`confirm:${BILL}:${seen}`, GAVIN));

    expect(reply.type).toBe(7);
    expect(shown(reply.data)).toMatch(/confirmed/i);
    expect(shown(reply.data)).toMatch(/<@marcus>[^\\"]*\$44\.46/);
    expect(customIds(reply.data)).toEqual([`open:${BILL}`, `reopen:${BILL}`, `delete:${BILL}`]);
    expect(reply.data.allowed_mentions).toEqual({ parse: [] });
    expect((await getBill(db, BILL))!.status).toBe("confirmed");
    // The stored message catches up too, in case an older edit was in flight.
    expect(messageEdits()).toHaveLength(1);
    expect(customIds(messageEdits()[0]!.body)).toEqual([`open:${BILL}`, `reopen:${BILL}`, `delete:${BILL}`]);
    expect(followUps()).toEqual([]);
  });

  it("refuses Confirm from anyone but the payer", async () => {
    await seedSaigon(db, BILL);

    const reply = await run(tap(`confirm:${BILL}:${await revision()}`, MARCUS));

    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toMatch(/only Gavin/i);
    expect((await getBill(db, BILL))!.status).toBe("draft");
  });

  it("refuses a Confirm tapped on a message drawn before the bill changed", async () => {
    await seedSaigon(db, BILL);
    const seen = await revision();
    await editItem(db, BILL, item("noodles"), { cents: 8200 });

    const reply = await run(tap(`confirm:${BILL}:${seen}`, GAVIN));

    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toMatch(/changed/i);
    expect((await getBill(db, BILL))!.status).toBe("draft");
    expect(await frozenShares()).toEqual([]);
  });

  it("offers to split unclaimed lines evenly, then confirms", async () => {
    await seedSaigon(db, BILL, { unclaimed: ["tea", "water"] });
    const seen = await revision();

    const offer = await run(tap(`confirm:${BILL}:${seen}`, GAVIN));

    expect(offer.data.flags).toBe(EPHEMERAL);
    expect(offer.data.content).toContain("Thai iced tea x3");
    expect(offer.data.content).toContain("Sparkling water");
    expect(customIds(offer.data)).toEqual([`orphans:${BILL}:${seen}`]);
    expect(offer.data.components[0].components[0].label).toBe("Split evenly and confirm");
    expect((await getBill(db, BILL))!.status).toBe("draft");

    const done = await run(tap(`orphans:${BILL}:${seen}`, GAVIN));

    expect(done.type).toBe(7);
    expect(done.data.content).toMatch(/confirmed/i);
    expect(done.data.components).toEqual([]);
    expect((await getBill(db, BILL))!.status).toBe("confirmed");
    expect((await frozenShares()).reduce((sum, s) => sum + s.owedCents, 0)).toBe(32412);
    expect(messageEdits()).toHaveLength(1);
    expect(customIds(messageEdits()[0]!.body)).toContain(`reopen:${BILL}`);
  });

  it("points the payer at the page when nobody has claimed anything", async () => {
    await seedSaigon(db, BILL, { unclaimed: SAIGON.items.map((i) => i.id) });

    const reply = await run(tap(`confirm:${BILL}:${await revision()}`, GAVIN));

    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toMatch(/nobody has claimed/i);
    expect(reply.data.content).toMatch(/Open the split/);
    expect(customIds(reply.data)).toEqual([]);
  });

  it("refuses to split the unclaimed lines once the bill has changed since the offer", async () => {
    await seedSaigon(db, BILL, { unclaimed: ["tea", "water"] });
    const seen = await revision();
    await setClaim(db, BILL, item("tea"), "jess", true);

    const reply = await run(tap(`orphans:${BILL}:${seen}`, GAVIN));

    expect(reply.type).toBe(7);
    expect(reply.data.content).toMatch(/changed/i);
    expect((await getBillItems(db, BILL)).find((i) => i.id === item("water"))!.claimedBy).toEqual([]);
    expect((await getBill(db, BILL))!.status).toBe("draft");
  });

  it("refuses to split the unclaimed lines for anyone but the payer", async () => {
    await seedSaigon(db, BILL, { unclaimed: ["tea", "water"] });
    const seen = await revision();

    const reply = await run(tap(`orphans:${BILL}:${seen}`, MARCUS));

    expect(reply.type).toBe(7);
    expect(reply.data.content).toMatch(/only Gavin/i);
    expect(reply.data.components).toEqual([]);
    expect((await getBillItems(db, BILL)).find((i) => i.id === item("tea"))!.claimedBy).toEqual([]);
    expect(await revision()).toBe(seen);
    expect((await getBill(db, BILL))!.status).toBe("draft");
  });

  it("says the bill was deleted when it goes while the unclaimed lines are being split", async () => {
    await seedSaigon(db, BILL, { unclaimed: ["tea", "water"] });
    const seen = await revision();
    const race = beforeFirstWrite(db, (real) => deleteBill(real, BILL, 0));

    const reply = await run(tap(`orphans:${BILL}:${seen}`, GAVIN), race.db);

    expect(race.raced()).toBe(true);
    expect(reply.type).toBe(7);
    expect(reply.data.content).toMatch(/deleted/i);
    expect(reply.data.content).not.toMatch(/already confirmed/i);
    expect((await getBillItems(db, BILL)).find((i) => i.id === item("tea"))!.claimedBy).toEqual([]);
  });

  it("brings the message up to date when Confirm is tapped on a bill that was already confirmed", async () => {
    await seedSaigon(db, BILL);
    const seen = await revision();
    await confirmed();

    const reply = await run(tap(`confirm:${BILL}:${seen}`, GAVIN));

    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toMatch(/already confirmed/i);
    expect(messageEdits()).toHaveLength(1);
    expect(customIds(messageEdits()[0]!.body)).toEqual([`open:${BILL}`, `reopen:${BILL}`, `delete:${BILL}`]);
  });
});

describe("Reopen", () => {
  it("returns the bill to draft with every claim intact", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    const claims = await getBillItems(db, BILL);

    const reply = await run(tap(`reopen:${BILL}`, GAVIN));

    expect(reply.type).toBe(7);
    const bill = (await getBill(db, BILL))!;
    expect(bill.status).toBe("draft");
    expect(customIds(reply.data)).toEqual([
      `open:${BILL}`,
      `confirm:${BILL}:${bill.revision}`,
      `delete:${BILL}`,
      `roster:${BILL}`,
    ]);
    expect(await getBillItems(db, BILL)).toEqual(claims);
    // Nobody had paid, so there is nothing to say out loud.
    expect(followUps()).toEqual([]);
  });

  it("refuses Reopen from anyone but the payer", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await run(tap(`reopen:${BILL}`, MARCUS));

    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toMatch(/only Gavin/i);
    expect((await getBill(db, BILL))!.status).toBe("confirmed");
  });

  it("says out loud when reopening moves what someone who paid owes", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await pay("marcus", 4446);
    await correctRollsBehindTheBillsBack();

    const reply = await run(tap(`reopen:${BILL}`, GAVIN));

    // Said in the channel, as the reply to the tap, rather than to the payer alone.
    expect(reply.type).toBe(4);
    expect(reply.data.flags ?? 0).toBe(0);
    expect(reply.data.content).toMatch(/Gavin reopened/);
    expect(reply.data.content).toContain("Marcus paid $44.46 and now owes $41.10, so Gavin owes Marcus $3.36.");
    expect(reply.data.allowed_mentions).toEqual({ parse: [] });
    expect((await getBill(db, BILL))!.status).toBe("draft");
    // The bill message itself still follows, on the coalesced edit.
    expect(messageEdits()).toHaveLength(1);
    expect(customIds(messageEdits()[0]!.body)).toContain(`roster:${BILL}`);
  });

  it("says out loud how a correction changes what someone who paid owes, when the bill is confirmed again", async () => {
    await seedSaigon(db, BILL);
    await run(tap(`confirm:${BILL}:${await revision()}`, GAVIN));
    await pay("marcus", 4446);
    await run(tap(`reopen:${BILL}`, GAVIN));
    // The payer fixes the misread line on the page, and the total with it.
    await editItem(db, BILL, item("rolls"), { cents: 642 });
    await setBillAmounts(db, BILL, { printedTotalCents: 24292 + 2232 });
    calls = [];
    await expireEditLease();

    const reply = await run(tap(`confirm:${BILL}:${await revision()}`, GAVIN));

    expect((await getBill(db, BILL))!.status).toBe("confirmed");
    expect((await frozenShares()).find((s) => s.participant === "marcus")!.owedCents).toBe(4110);
    expect(reply.type).toBe(4);
    expect(reply.data.flags ?? 0).toBe(0);
    expect(reply.data.content).toMatch(/Gavin confirmed/);
    expect(reply.data.content).toContain("Marcus paid $44.46 and now owes $41.10, so Gavin owes Marcus $3.36.");
    expect(reply.data.allowed_mentions).toEqual({ parse: [] });
    expect(messageEdits()).toHaveLength(1);
    expect(shown(messageEdits()[0]!.body)).toMatch(/<@marcus>[^\\"]*\$41\.10/);
    expect(followUps()).toEqual([]);
  });

  it("says when a correction means someone who paid owes more", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await pay("marcus", 4446);
    await run(tap(`reopen:${BILL}`, GAVIN));
    await editItem(db, BILL, item("rolls"), { cents: 2100 });
    await setBillAmounts(db, BILL, { printedTotalCents: 25750 + 2232 });
    calls = [];
    const nowCents = splitBill(await toSplitInput(db, BILL)).shares.find((s) => s.participant === "marcus")!.owedCents;
    expect(nowCents).toBeGreaterThan(4446);

    const reply = await run(tap(`confirm:${BILL}:${await revision()}`, GAVIN));

    expect(reply.data.content).toContain(
      `Marcus paid $44.46 and now owes ${formatCents(nowCents)}, so Marcus owes Gavin ${formatCents(nowCents - 4446)} more.`,
    );
  });
});

describe("Delete", () => {
  it("requires a second confirmation to delete a bill with settlements", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await pay("marcus", 4446);
    await pay("dani", 2000);

    const ask = await run(tap(`delete:${BILL}`, GAVIN));

    expect(ask.type).toBe(4);
    expect(ask.data.flags).toBe(EPHEMERAL);
    expect(ask.data.content).toMatch(/Marcus[^\n]*\$44\.46/);
    expect(ask.data.content).toMatch(/Dani[^\n]*\$20\.00/);
    expect(ask.data.content).toContain("$64.46");
    expect(customIds(ask.data)).toEqual([`delete-confirm:${BILL}:6446`]);
    expect((await getBill(db, BILL))!.status).toBe("confirmed");

    const done = await run(tap(`delete-confirm:${BILL}:6446`, GAVIN));

    expect(done.type).toBe(7);
    expect(done.data.content).toMatch(/deleted/i);
    expect(done.data.components).toEqual([]);
    expect((await getBill(db, BILL))!.status).toBe("deleted");
    // A soft delete: the payments are still on record.
    const { n } = (await db.prepare("SELECT COUNT(*) AS n FROM settlements WHERE bill_id = ?").bind(BILL).first<{ n: number }>())!;
    expect(n).toBe(2);
    expect(messageEdits()).toHaveLength(1);
    expect(messageEdits()[0]!.body.components).toEqual([]);
    expect(shown(messageEdits()[0]!.body)).toMatch(/deleted/i);
  });

  it("asks once even when nobody has paid, since everyone's claims go with it", async () => {
    await seedSaigon(db, BILL);

    const ask = await run(tap(`delete:${BILL}`, GAVIN));

    expect(ask.data.flags).toBe(EPHEMERAL);
    expect(ask.data.content).toMatch(/claims/i);
    expect(ask.data.content).not.toMatch(/paid/i);
    expect(customIds(ask.data)).toEqual([`delete-confirm:${BILL}:0`]);
    expect((await getBill(db, BILL))!.status).toBe("draft");

    await run(tap(`delete-confirm:${BILL}:0`, GAVIN));
    expect((await getBill(db, BILL))!.status).toBe("deleted");
  });

  it("refuses Delete from anyone but the payer, at either step", async () => {
    await seedSaigon(db, BILL);

    const ask = await run(tap(`delete:${BILL}`, MARCUS));
    expect(ask.data.flags).toBe(EPHEMERAL);
    expect(ask.data.content).toMatch(/only Gavin/i);
    expect(customIds(ask.data)).toEqual([]);

    const forced = await run(tap(`delete-confirm:${BILL}:0`, MARCUS));
    expect(forced.data.content).toMatch(/only Gavin/i);
    expect((await getBill(db, BILL))!.status).toBe("draft");
    expect(messageEdits()).toEqual([]);
  });

  it("refuses the final Delete tap from anyone but the payer, even on a prompt that matches", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await pay("marcus", 4446);

    const forced = await run(tap(`delete-confirm:${BILL}:4446`, MARCUS));

    expect(forced.type).toBe(7);
    expect(forced.data.content).toMatch(/only Gavin/i);
    expect(forced.data.components).toEqual([]);
    expect((await getBill(db, BILL))!.status).toBe("confirmed");
    expect(messageEdits()).toEqual([]);
  });

  it("discards no payment recorded after the prompt was drawn, and asks again naming it", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    const ask = await run(tap(`delete:${BILL}`, GAVIN));
    expect(customIds(ask.data)).toEqual([`delete-confirm:${BILL}:0`]);
    // Marcus pays while the payer is still looking at a prompt that names nobody.
    await pay("marcus", 4446);

    const stale = await run(tap(`delete-confirm:${BILL}:0`, GAVIN));

    expect(stale.type).toBe(7);
    expect(stale.data.content).toMatch(/Marcus[^\n]*\$44\.46/);
    expect(customIds(stale.data)).toEqual([`delete-confirm:${BILL}:4446`]);
    expect((await getBill(db, BILL))!.status).toBe("confirmed");
    expect(messageEdits()).toEqual([]);

    const done = await run(tap(`delete-confirm:${BILL}:4446`, GAVIN));

    expect(done.data.content).toMatch(/deleted/i);
    expect((await getBill(db, BILL))!.status).toBe("deleted");
  });

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
