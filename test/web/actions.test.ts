import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import {
  addGuest,
  addParticipant,
  confirmBill,
  createBill,
  editItem,
  getBill,
  getBillItems,
  getParticipants,
  getShares,
  insertItems,
  setBillAmounts,
  setClaim,
  toSplitInput,
} from "../../src/db/bills";
import { getVenmoHandles } from "../../src/db/handles";
import { listSettlements, recordSettlement } from "../../src/db/settlements";
import type { Env } from "../../src/env";
import { formatCents } from "../../src/format";
import { splitBill } from "../../src/money/split";
import { mintToken } from "../../src/web/token";
import { SAIGON } from "../fixtures/saigon";
import { seedSaigon } from "../fixtures/seed";

const db = workerEnv.DB;
const KEY = "actions-test-signing-key";
const BILL = "bill-1";
const API = "https://discord.com/api/v10";
const MESSAGE = `${API}/channels/chan-1/messages/msg-1`;
const SAIGON_KITCHEN = "Saigon Kitchen, Oct 28, 2026";

const item = (id: string) => `${BILL}-${id}`;

function env(): Env {
  return {
    DB: db,
    DISCORD_PUBLIC_KEY: "00",
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_APPLICATION_ID: "app-1",
    ANTHROPIC_API_KEY: "unused",
    TOKEN_SIGNING_KEY: KEY,
  };
}

let calls: { url: string; method: string; body: any }[];

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
  await db.prepare("DELETE FROM payment_handles").run();
  calls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json({ id: "msg-2", channel_id: "chan-1" });
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

interface Reply {
  status: number;
  body: any;
}

async function send(method: string, path: string, as: string, body?: unknown): Promise<Reply> {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${await mintToken(BILL, as, KEY, Date.now())}`,
  };
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`https://aazhi.test/b/${BILL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env(),
    ctx,
  );
  await settle(waitOnExecutionContext(ctx));
  return { status: response.status, body: await response.json() };
}

function plain(cents: number): string {
  return (cents / 100).toFixed(2);
}

async function revision(): Promise<number> {
  return (await getBill(db, BILL))!.revision;
}

async function status(): Promise<string | undefined> {
  return (await getBill(db, BILL))?.status;
}

async function confirmed(): Promise<void> {
  expect(await confirmBill(db, BILL, await revision(), "gavin")).toMatchObject({ ok: true });
}

async function owedOf(who: string): Promise<number> {
  return (await getShares(db, BILL)).find((s) => s.participant === who)!.owedCents;
}

async function confirm(as = "gavin", extra: Record<string, unknown> = {}): Promise<Reply> {
  return send("POST", "/confirm", as, { revision: await revision(), ...extra });
}

function pay(as: string, cents: number, options: { id?: string } = {}): Promise<Reply> {
  return send("POST", "/payment", as, { id: options.id ?? crypto.randomUUID(), amount: plain(cents) });
}

// Message edits are coalesced on D1's real clock, which fake timers do not
// move, so a test that wants to see the next edit clears the window first.
async function freshEdits(): Promise<void> {
  calls = [];
  await db.prepare("UPDATE bills SET edit_lease_until = NULL WHERE id = ?").bind(BILL).run();
}

function messageEdits() {
  return calls.filter((c) => c.method === "PATCH" && c.url === MESSAGE);
}

function channelPosts(): string[] {
  return calls.filter((c) => c.method === "POST" && c.url === `${API}/channels/chan-1/messages`).map((c) => c.body.content);
}

function customIds(data: any): string[] {
  return ((data.components ?? []) as any[]).flatMap((row) => row.components.map((c: any) => c.custom_id));
}

describe("confirming on the page", () => {
  it("locks the bill, freezes the shares and brings the message to one button", async () => {
    await seedSaigon(db, BILL);

    const reply = await confirm();

    expect(reply.status).toBe(200);
    expect(reply.body.status).toBe("confirmed");
    expect(await status()).toBe("confirmed");
    expect(await owedOf("marcus")).toBe(4446);
    expect(messageEdits()).toHaveLength(1);
    expect(customIds(messageEdits()[0]!.body)).toEqual([`open:${BILL}`]);
    // A first confirm changes nothing anyone was already told.
    expect(channelPosts()).toEqual([]);
  });

  it("is the payer's alone", async () => {
    await seedSaigon(db, BILL);

    const reply = await confirm("marcus");

    expect(reply.status).toBe(403);
    expect(reply.body.error).toBe("Only Gavin can confirm the bill, because they paid.");
    expect(await status()).toBe("draft");
  });

  it("refuses a confirm sent from a page drawn before the bill changed", async () => {
    await seedSaigon(db, BILL);
    const seen = await revision();
    await editItem(db, BILL, item("noodles"), { baseCents: 8200 });

    const reply = await send("POST", "/confirm", "gavin", { revision: seen });

    expect(reply.status).toBe(409);
    expect(reply.body.error).toBe("The bill changed while you were looking. Check it and confirm again.");
    expect(await status()).toBe("draft");
  });

  it("says the lines do not add up, in the payer's words", async () => {
    await seedSaigon(db, BILL);
    await editItem(db, BILL, item("noodles"), { baseCents: 8200 });

    const reply = await confirm();

    expect(reply.status).toBe(409);
    expect(reply.body.error).toBe("Line items do not add up to total!");
  });

  it("refuses while a line has nobody on it, and splits those lines evenly when asked", async () => {
    await seedSaigon(db, BILL, { unclaimed: ["tea", "water"] });

    const refused = await confirm();
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("Some lines have nobody on them yet.");

    const done = await confirm("gavin", { splitUnclaimed: true });

    expect(done.status).toBe(200);
    expect(await status()).toBe("confirmed");
    expect((await getShares(db, BILL)).reduce((sum, s) => sum + s.owedCents, 0)).toBe(32412);
    expect((await getBillItems(db, BILL)).every((i) => i.claimedBy.length > 0)).toBe(true);
  });

  it("splits nothing when nobody has claimed anything, or the bill changed since the payer looked", async () => {
    await seedSaigon(db, BILL, { unclaimed: SAIGON.items.map((i) => i.id) });
    const nobody = await confirm("gavin", { splitUnclaimed: true });
    expect(nobody.status).toBe(409);
    expect(nobody.body.error).toBe("Nobody has claimed anything yet.");

    await db.prepare("DELETE FROM bills").run();
    await seedSaigon(db, BILL, { unclaimed: ["tea", "water"] });
    const seen = await revision();
    await setClaim(db, BILL, item("tea"), "jess", true);
    const stale = await send("POST", "/confirm", "gavin", { revision: seen, splitUnclaimed: true });

    expect(stale.status).toBe(409);
    expect((await getBillItems(db, BILL)).find((i) => i.id === item("water"))!.claimedBy).toEqual([]);
    expect(await status()).toBe("draft");
  });

  it("refuses to split the unclaimed lines for anyone but the payer", async () => {
    await seedSaigon(db, BILL, { unclaimed: ["tea", "water"] });
    const seen = await revision();

    const reply = await confirm("marcus", { splitUnclaimed: true });

    expect(reply.status).toBe(403);
    expect((await getBillItems(db, BILL)).find((i) => i.id === item("tea"))!.claimedBy).toEqual([]);
    expect(await revision()).toBe(seen);
  });

  it("says out loud how a correction changes what someone who paid owes", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 4446, "marcus");
    expect((await send("POST", "/reopen", "gavin")).status).toBe(200);
    // The payer fixes the misread spring rolls, and the total with them.
    await editItem(db, BILL, item("rolls"), { baseCents: 642 });
    await setBillAmounts(db, BILL, { printedTotalCents: 24292 + 2232 });

    expect((await confirm()).status).toBe(200);

    expect(await owedOf("marcus")).toBe(4110);
    expect(channelPosts().at(-1)).toBe(
      `Gavin confirmed ${SAIGON_KITCHEN} again, and the amounts changed for people who had already paid:\n` +
        "- Marcus paid $44.46 and now owes $41.10, so Gavin owes Marcus $3.36.",
    );
  });

  it("says when a correction means someone who paid owes more", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 4446, "marcus");
    await send("POST", "/reopen", "gavin");
    await editItem(db, BILL, item("rolls"), { baseCents: 2100 });
    await setBillAmounts(db, BILL, { printedTotalCents: 25750 + 2232 });
    const nowCents = splitBill(await toSplitInput(db, BILL)).shares.find((s) => s.participant === "marcus")!.owedCents;
    expect(nowCents).toBeGreaterThan(4446);

    await confirm();

    expect(channelPosts().at(-1)).toContain(
      `Marcus paid $44.46 and now owes ${formatCents(nowCents)}, so Marcus owes Gavin ${formatCents(nowCents - 4446)} more.`,
    );
  });
});

describe("reopening", () => {
  it("lets the payer take the bill back to a draft with every claim intact, quietly when nobody paid", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    const claims = await getBillItems(db, BILL);

    const reply = await send("POST", "/reopen", "gavin");

    expect(reply.status).toBe(200);
    expect(reply.body.status).toBe("draft");
    expect(await getBillItems(db, BILL)).toEqual(claims);
    expect(customIds(messageEdits()[0]!.body)).toEqual([`open:${BILL}`, `roster:${BILL}`]);
    expect(channelPosts()).toEqual([]);
  });

  it("says out loud when the payer's reopen moves what someone who paid owes", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 4446, "marcus");
    await db.prepare("UPDATE bill_items SET cents = 642 WHERE id = ?").bind(item("rolls")).run();

    await send("POST", "/reopen", "gavin");

    expect(channelPosts()).toEqual([
      `Gavin reopened ${SAIGON_KITCHEN} to fix it, so paying is paused until it's confirmed again. As it stands now:\n` +
        "- Marcus paid $44.46 and now owes $41.10, so Gavin owes Marcus $3.36.",
    ]);
  });

  it("lets anyone on the bill say something's wrong, which pauses paying and names them", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await send("POST", "/reopen", "dani");

    expect(reply.status).toBe(200);
    expect(await status()).toBe("draft");
    expect(channelPosts()).toEqual([
      `Dani said something's wrong on ${SAIGON_KITCHEN}, so paying is paused until Gavin fixes it and confirms again.`,
    ]);
  });

  it("refuses someone who is not on the bill, and a bill that is already a draft", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const outsider = await send("POST", "/reopen", "zoe");
    expect(outsider.status).toBe(403);
    expect(await status()).toBe("confirmed");

    await send("POST", "/reopen", "dani");
    const again = await send("POST", "/reopen", "marcus");
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("This bill is already back to a draft, so paying is paused.");
    expect(channelPosts()).toHaveLength(1);
  });
});

describe("recording a payment", () => {
  it("records paying it all, updates the message and says so in the channel", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await pay("marcus", 4446);

    expect(reply.status).toBe(200);
    expect(reply.body.owing.marcus).toEqual({ owedCents: 4446, paidCents: 4446 });
    expect(await listSettlements(db, BILL)).toMatchObject([{ participant: "marcus", cents: 4446, recordedBy: "marcus" }]);
    expect(messageEdits()).toHaveLength(1);
    expect(channelPosts()).toEqual([`Marcus paid Gavin $44.46 for ${SAIGON_KITCHEN}, and is all paid up.`]);
  });

  it("refuses part of it, since someone has paid or they haven't", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await pay("marcus", 2000);

    expect(reply.status).toBe(409);
    expect(reply.body.error).toBe("What you owe changed. You have $44.46 left to pay.");
    expect(await listSettlements(db, BILL)).toEqual([]);
    expect(channelPosts()).toEqual([]);
  });

  it("records a retried send once", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    const id = crypto.randomUUID();

    expect((await pay("marcus", 4446, { id })).status).toBe(200);
    const again = await pay("marcus", 4446, { id });

    expect(again.status).toBe(200);
    expect(again.body.owing.marcus.paidCents).toBe(4446);
    expect(await listSettlements(db, BILL)).toHaveLength(1);
    expect(channelPosts()).toHaveLength(1);
  });

  it("refuses an amount that is more than is left, or nothing, and records nothing", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const over = await pay("marcus", 5000);
    expect(over.status).toBe(409);
    expect(over.body.error).toBe("What you owe changed. You have $44.46 left to pay.");
    const zero = await pay("marcus", 0);
    expect(zero.status).toBe(400);
    expect(zero.body.error).toBe("That amount is $0.00, so there's nothing to record.");
    expect(await listSettlements(db, BILL)).toEqual([]);
  });

  it("refuses a payment sent against an amount that has since changed, and says what is left now", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 1000, "marcus");

    const reply = await pay("marcus", 4446);

    expect(reply.status).toBe(409);
    expect(reply.body.error).toBe("What you owe changed. You have $34.46 left to pay.");
    expect(await listSettlements(db, BILL)).toHaveLength(1);
  });

  it("changes nothing when someone already paid taps I paid again", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await pay("marcus", 4446);
    await freshEdits();

    const reply = await pay("marcus", 4446);

    expect(reply.status).toBe(200);
    expect(reply.body.owing.marcus).toEqual({ owedCents: 4446, paidCents: 4446 });
    expect(await listSettlements(db, BILL)).toHaveLength(1);
    expect(messageEdits()).toEqual([]);
    expect(channelPosts()).toEqual([]);
  });

  it("refuses the payer, someone not on the bill, and a reopened bill", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    expect((await pay("gavin", 100)).status).toBe(403);
    const outsider = await pay("zoe", 100);
    expect(outsider.status).toBe(409);
    expect(outsider.body.error).toBe("You have no share on this bill, so there's nothing for you to pay.");
    await send("POST", "/reopen", "gavin");
    const paused = await pay("marcus", 100);
    expect(paused.status).toBe(409);
    expect(paused.body.error).toBe("This bill was reopened, so paying is paused until Gavin confirms it again.");
    expect(await listSettlements(db, BILL)).toEqual([]);
  });

  it("refuses a payment id that is not one the page would send", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await send("POST", "/payment", "marcus", { id: "a b", amount: "1.00" });

    expect(reply.status).toBe(400);
  });
});

describe("the payer marking someone paid", () => {
  const ID = "tap-11111111";

  it("records the same payment I paid does, out loud, and says who recorded it", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await freshEdits();

    const reply = await send("POST", "/paid/marcus", "gavin", { id: ID, amount: "44.46" });

    expect(reply.status).toBe(200);
    expect(reply.body.paid).toContain("marcus");
    expect(await listSettlements(db, BILL)).toMatchObject([{ participant: "marcus", cents: 4446, recordedBy: "gavin" }]);
    const settled = await db.prepare("SELECT settled_at FROM shares WHERE bill_id = ? AND participant_id = 'marcus'").bind(BILL).first<{ settled_at: string | null }>();
    expect(settled?.settled_at).not.toBeNull();
    expect(messageEdits()).toHaveLength(1);
    expect(channelPosts()).toEqual([`Gavin marked Marcus paid $44.46 for ${SAIGON_KITCHEN}. Marcus is all paid up.`]);
  });

  it("derives settled_at the way the debtor's own payment does, and Undo takes it back", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    await pay("dani", (await send("GET", "/state", "dani")).body.owing.dani.owedCents);
    await send("POST", "/paid/marcus", "gavin", { id: ID, amount: "44.46" });
    const rows = await db.prepare("SELECT participant_id, settled_at FROM shares WHERE bill_id = ? AND participant_id IN ('dani', 'marcus')").bind(BILL).all<{ settled_at: string | null }>();
    expect(rows.results.every((r) => r.settled_at !== null)).toBe(true);

    expect((await send("DELETE", "/paid/marcus", "gavin")).status).toBe(200);
    expect((await listSettlements(db, BILL)).map((p) => p.participant)).toEqual(["dani"]);
  });

  it("does nothing the second time, for a retry and for a second tap alike", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    await send("POST", "/paid/marcus", "gavin", { id: ID, amount: "44.46" });
    await send("POST", "/paid/marcus", "gavin", { id: ID, amount: "44.46" });
    const again = await send("POST", "/paid/marcus", "gavin", { id: "tap-22222222", amount: "44.46" });

    expect(again.status).toBe(200);
    expect(await listSettlements(db, BILL)).toHaveLength(1);
    expect(channelPosts()).toHaveLength(1);
  });

  it("refuses anyone but the payer, an amount that moved, and a reopened bill", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const diner = await send("POST", "/paid/dani", "marcus", { id: ID, amount: "1.00" });
    expect(diner.status).toBe(403);
    expect(diner.body.error).toBe("Only Gavin can mark someone paid, because it was paid to them.");

    const moved = await send("POST", "/paid/marcus", "gavin", { id: ID, amount: "1.00" });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toBe("What Marcus owes changed. They have $44.46 left to pay.");

    const self = await send("POST", "/paid/gavin", "gavin", { id: ID, amount: "1.00" });
    expect(self.status).toBe(409);

    await send("POST", "/reopen", "gavin");
    const reopened = await send("POST", "/paid/marcus", "gavin", { id: ID, amount: "44.46" });
    expect(reopened.status).toBe(409);
    expect(reopened.body.error).toBe("This bill was reopened, so payments are paused until you confirm it again.");
    expect(await listSettlements(db, BILL)).toEqual([]);
  });
});

describe("undoing a payment", () => {
  it("lists payments for the payer alone, newest first", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 1000, "marcus");
    await recordSettlement(db, BILL, "dani", 2000, "dani");

    const payer = (await send("GET", "/state", "gavin")).body;
    expect(payer.payments.map((p: any) => [p.participant, p.cents])).toEqual([
      ["dani", 2000],
      ["marcus", 1000],
    ]);
    expect((await send("GET", "/state", "marcus")).body.payments).toEqual([]);
  });

  it("lets the payer take someone's paid back, out loud", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await pay("marcus", 4446);
    await freshEdits();

    const reply = await send("DELETE", "/paid/marcus", "gavin");

    expect(reply.status).toBe(200);
    expect(reply.body.payments).toEqual([]);
    expect(await listSettlements(db, BILL)).toEqual([]);
    expect(messageEdits()).toHaveLength(1);
    expect(channelPosts()).toEqual([`Gavin removed Marcus's $44.46 payment on ${SAIGON_KITCHEN}. Marcus has $44.46 left to pay.`]);
  });

  it("refuses anyone but the payer, someone paid only on another bill, and a reopened bill", async () => {
    await seedSaigon(db, BILL);
    await seedSaigon(db, "bill-2", { bill: { channelId: "chan-2", messageId: "msg-2" } });
    await confirmed();
    expect(await confirmBill(db, "bill-2", (await getBill(db, "bill-2"))!.revision, "gavin")).toMatchObject({ ok: true });
    await pay("marcus", 4446);
    await recordSettlement(db, "bill-2", "dani", 100, "dani");

    const diner = await send("DELETE", "/paid/marcus", "marcus");
    expect(diner.status).toBe(403);
    expect(diner.body.error).toBe("Only Gavin can undo a payment, because it was paid to them.");
    const gone = await send("DELETE", "/paid/dani", "gavin");
    expect(gone.status).toBe(404);
    expect(gone.body.error).toBe("That payment isn't on this bill any more.");

    await send("POST", "/reopen", "gavin");
    const reopened = await send("DELETE", "/paid/marcus", "gavin");
    expect(reopened.status).toBe(409);
    expect(await listSettlements(db, BILL)).toHaveLength(1);
    expect(await listSettlements(db, "bill-2")).toHaveLength(1);
  });
});

describe("deleting", () => {
  it("deletes a bill with payments when the payer agreed to the total the page showed, keeping the payments on record", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await pay("marcus", 4446);
    await recordSettlement(db, BILL, "dani", 2000, "dani");
    await freshEdits();

    const reply = await send("DELETE", "", "gavin", { paid: "64.46" });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ deleted: true });
    expect(await status()).toBe("deleted");
    expect(await listSettlements(db, BILL)).toHaveLength(2);
    expect(messageEdits()).toHaveLength(1);
    expect(messageEdits()[0]!.body.components).toEqual([]);
    expect(JSON.stringify(messageEdits()[0]!.body)).toMatch(/deleted/i);
  });

  it("deletes nothing when someone paid since the payer looked", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await pay("marcus", 4446);

    const reply = await send("DELETE", "", "gavin", { paid: "0.00" });

    expect(reply.status).toBe(409);
    expect(reply.body.error).toBe("Someone paid since you looked, so nothing was deleted. Look again before you delete it.");
    expect(await status()).toBe("confirmed");
  });

  it("is the payer's alone, on a draft or a confirmed bill", async () => {
    await seedSaigon(db, BILL);

    const draft = await send("DELETE", "", "marcus", { paid: "0.00" });
    expect(draft.status).toBe(403);
    expect(draft.body.error).toBe("Only Gavin can delete the bill, because they paid.");
    await confirmed();
    expect((await send("DELETE", "", "dani", { paid: "0.00" })).status).toBe(403);
    expect(await status()).toBe("confirmed");
    expect((await send("DELETE", "", "gavin", { paid: "0.00" })).status).toBe(200);
    expect(await status()).toBe("deleted");
  });
});

describe("taking someone off a draft", () => {
  const bystander = () => addParticipant(db, { billId: BILL, id: "bystander", kind: "member", displayName: "Sam", addedBy: null });
  const remove = (as: string, id = "bystander") => send("DELETE", `/member/${id}`, as);

  it("takes off a member who claimed nothing and updates the message", async () => {
    await seedSaigon(db, BILL);
    await bystander();

    const reply = await remove("gavin");

    expect(reply.status).toBe(200);
    expect(reply.body.participants.map((p: any) => p.id)).not.toContain("bystander");
    expect(messageEdits()).toHaveLength(1);
  });

  it("is for the payer only", async () => {
    await seedSaigon(db, BILL);
    await bystander();

    const reply = await remove("theo");

    expect(reply.status).toBe(403);
    expect(reply.body.error).toBe("Only Gavin can take people off the bill, because they paid.");
    expect((await getParticipants(db, BILL)).map((p) => p.id)).toContain("bystander");
  });

  it("clears a person's lines with them, and what's left adds up", async () => {
    await createBill(db, {
      id: BILL,
      guildId: "guild-1",
      channelId: "chan-1",
      messageId: "msg-1",
      payerId: "gavin",
      place: "Saigon Kitchen",
      billDate: "2026-10-28",
      discountCents: 0,
      taxCents: 300,
      tipCents: 300,
      printedTotalCents: 3300,
      status: "draft",
    });
    await insertItems(db, BILL, [
      { id: "solo", label: "Pho", cents: 1200, source: "ocr" },
      { id: "shared", label: "Rolls", cents: 900, source: "ocr" },
      { id: "mine", label: "Tea", cents: 900, source: "ocr" },
    ]);
    for (const [id, name] of [["gavin", "Gavin"], ["theo", "Theo"], ["sam", "Sam"]] as const) {
      await addParticipant(db, { billId: BILL, id, kind: "member", displayName: name, addedBy: null });
    }
    for (const [line, who] of [["solo", "sam"], ["shared", "sam"], ["shared", "theo"], ["shared", "gavin"], ["mine", "gavin"]] as const) {
      await setClaim(db, BILL, line, who, true);
    }
    const owed = (body: any) => Object.fromEntries(body.result.shares.map((s: any) => [s.participant, s.owedCents]));
    const before = await send("GET", "/state", "gavin");
    expect(owed(before.body)).toEqual({ gavin: 1440, theo: 360, sam: 1800 });

    const reply = await remove("gavin", "sam");

    expect(reply.status).toBe(200);
    expect(reply.body.items.map((i: any) => i.claimedBy.toSorted())).toEqual([[], ["gavin", "theo"], ["gavin"]]);
    expect(owed(reply.body)).toEqual({ gavin: 1620, theo: 540 });
    expect(reply.body.result.unclaimedCents).toBe(1440);
    expect(1620 + 540 + 1440).toBe(reply.body.result.distributableCents);

    expect((await send("POST", "/confirm", "gavin", { revision: await revision(), splitUnclaimed: true })).status).toBe(200);
    const shares = await getShares(db, BILL);
    expect(Object.fromEntries(shares.map((s) => [s.participant, s.owedCents]))).toEqual({ gavin: 2340, theo: 1260 });
  });

  it("says why it can't take someone off", async () => {
    await seedSaigon(db, BILL);
    await bystander();
    await addGuest(db, BILL, { id: "guest-kim", displayName: "Kim", addedBy: "bystander" });

    expect(await remove("gavin")).toEqual({ status: 409, body: { error: "Sam brought a guest. Take the guest off first." } });
    expect(await remove("gavin", "gavin")).toEqual({ status: 400, body: { error: "You paid the bill, so you stay on it." } });
    expect((await remove("gavin", "nobody")).status).toBe(404);
  });

  it("refuses once the bill is confirmed, when everyone on it was told an amount", async () => {
    await seedSaigon(db, BILL);
    await bystander();
    await confirmed();

    expect((await remove("gavin")).status).toBe(409);
    expect((await getParticipants(db, BILL)).map((p) => p.id)).toContain("bystander");
  });
});

describe("saving a Venmo username", () => {
  const save = (as: string, username: unknown) => send("POST", "/venmo", as, { username });
  const saved = async (id: string) => (await getVenmoHandles(db, [id])).get(id);

  it("saves it for whoever the link belongs to, on a draft or a confirmed bill", async () => {
    await seedSaigon(db, BILL);

    const reply = await save("gavin", " @gavin-lin ");

    expect(reply.status).toBe(200);
    expect(reply.body.viewerVenmo).toBe("gavin-lin");
    expect(await saved("gavin")).toBe("gavin-lin");

    await confirmed();
    expect((await save("theo", "theo-ng")).status).toBe(200);
    expect(await saved("theo")).toBe("theo-ng");
  });

  it("replaces an earlier one, and the other pages pick it up without a new revision", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    const before = await revision();

    await save("gavin", "gavin-lin");
    await save("gavin", "gavin-l2");

    expect(await revision()).toBe(before);
    const theo = await send("GET", "/state", "theo");
    expect(theo.body.pay.appUrl).toContain("venmo://paycharge?txn=pay&recipients=gavin-l2&amount=");
    expect(theo.body.viewerVenmo).toBeNull();
  });

  it("turns down something that isn't a Venmo username and keeps what was there", async () => {
    await seedSaigon(db, BILL);
    await save("gavin", "gavin-lin");

    for (const bad of ["no", "evil.example/x?txn=charge", 12345]) {
      expect(await save("gavin", bad)).toEqual({
        status: 400,
        body: { error: "A Venmo username is 5 to 30 letters, numbers, hyphens or underscores, like @gavin-lin." },
      });
    }
    expect(await saved("gavin")).toBe("gavin-lin");
  });

  it("is for people on the bill, and only while it's live", async () => {
    await seedSaigon(db, BILL);

    expect((await save("stranger", "strange-1")).status).toBe(403);
    expect(await saved("stranger")).toBeUndefined();

    await db.prepare("UPDATE bills SET status = 'deleted' WHERE id = ?").bind(BILL).run();
    expect((await save("gavin", "gavin-lin")).status).toBe(409);
    expect(await saved("gavin")).toBeUndefined();
  });
});
