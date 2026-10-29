import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { confirmBill, editItem, getBill, getBillItems, getShares, setBillAmounts, setClaim, toSplitInput } from "../../src/db/bills";
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
