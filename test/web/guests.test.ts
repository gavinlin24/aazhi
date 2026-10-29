import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import {
  addItem,
  confirmBill,
  editItem,
  getBill,
  getBillSnapshot,
  getParticipants,
  getShares,
  reopenBill,
  setBillAmounts,
} from "../../src/db/bills";
import { ledger, listSettlements, outstanding, recordSettlement } from "../../src/db/settlements";
import { renderBill } from "../../src/discord/render";
import type { Env } from "../../src/env";
import { formatCents } from "../../src/format";
import { splitBill } from "../../src/money/split";
import { renderPage } from "../../src/web/page";
import { mintToken } from "../../src/web/token";
import { generateKeypair, signedRequest, type TestKeypair } from "../discord/helpers";
import { seedSaigon } from "../fixtures/seed";
import { one, select } from "./html";

const db = workerEnv.DB;
const KEY = "guests-test-signing-key";
const BILL = "bill-1";
const API = "https://discord.com/api/v10";
const APP_ID = "app-1";
const EPHEMERAL = 1 << 6;
// The Saigon printed total plus the 2000 line Sam claims.
const WITH_LOBSTER = 27382 + 2000;

let keypair: TestKeypair;
const ready = generateKeypair().then((k) => (keypair = k));

function env(): Env {
  return {
    DB: db,
    DISCORD_PUBLIC_KEY: keypair.publicKeyHex,
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_APPLICATION_ID: APP_ID,
    ANTHROPIC_API_KEY: "unused",
    TOKEN_SIGNING_KEY: KEY,
  };
}

let calls: { url: string; method: string; body: any; authorization: string | null }[];

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
  await db.prepare("DELETE FROM payment_handles").run();
  calls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: new Headers(init?.headers).get("authorization"),
    });
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

interface Reply {
  status: number;
  body: any;
}

async function send(method: string, path: string, as: string, body?: unknown): Promise<Reply> {
  await ready;
  const billId = path.split("/")[2]!;
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${await mintToken(billId, as, KEY, Date.now())}`,
  };
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`https://aazhi.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env(),
    ctx,
  );
  await settle(waitOnExecutionContext(ctx));
  return { status: response.status, body: await response.json() };
}

function addGuest(as: string, body: unknown, billId = BILL) {
  return send("POST", `/b/${billId}/guest`, as, body);
}

function pardon(as: string, participantId: string, pardoned = true, billId = BILL) {
  return send("POST", `/b/${billId}/pardon`, as, { participantId, pardoned });
}

function claimFor(as: string, itemId: string, participantId: string) {
  return send("POST", `/b/${BILL}/claim`, as, { itemId, participantId, claimed: true });
}

async function run(body: unknown): Promise<any> {
  await ready;
  const ctx = createExecutionContext();
  const response = await app.fetch(await signedRequest(keypair, body), env(), ctx);
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
const DANI = member("dani", "Dani");
const MARCUS = member("marcus", "Marcus");

function tap(customId: string, who: unknown) {
  return {
    id: "int-1",
    application_id: APP_ID,
    type: 3,
    token: "interaction-token",
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    channel: { id: "chan-1", type: 0 },
    member: who,
    message: { id: "msg-1", channel_id: "chan-1" },
    data: { custom_id: customId, component_type: 2 },
  };
}

function ledgerCommand(who: unknown) {
  return {
    id: "int-4",
    application_id: APP_ID,
    type: 2,
    token: "interaction-token",
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    channel: { id: "chan-1", type: 0 },
    member: who,
    data: { id: "cmd-2", name: "ledger", type: 1 },
  };
}

function customIds(data: any): string[] {
  return ((data.components ?? []) as any[]).flatMap((row) => row.components ?? []).flatMap((c: any) => (c.custom_id ? [c.custom_id] : []));
}

function channelPosts() {
  return calls.filter((c) => c.method === "POST" && c.url === `${API}/channels/chan-1/messages`);
}

function messageEdits() {
  return calls.filter((c) => c.method === "PATCH" && c.url === `${API}/channels/chan-1/messages/msg-1`);
}

async function confirmed(billId = BILL): Promise<void> {
  const bill = (await getBill(db, billId))!;
  expect(await confirmBill(db, billId, bill.revision, "gavin")).toMatchObject({ ok: true });
}

// Dani brought Sam, who had the lobster. The payer puts Sam on the bill (only
// the payer adds guests) and names Dani as who Sam came with.
async function withGuest(name = "Sam", companion = "dani", billId = BILL): Promise<string> {
  const reply = await addGuest("gavin", { name, with: companion }, billId);
  expect(reply.status).toBe(200);
  const guest = (await getParticipants(db, billId)).find((p) => p.kind === "guest" && p.displayName === name)!;
  const item = `${billId}-lobster-${name}`;
  await addItem(db, billId, { id: item, label: "Lobster", cents: 2000, source: "manual" });
  await setBillAmounts(db, billId, { printedTotalCents: WITH_LOBSTER });
  const claim = await send("POST", `/b/${billId}/claim`, "gavin", { itemId: item, participantId: guest.id, claimed: true });
  expect(claim.status).toBe(200);
  return guest.id;
}

async function owedOf(who: string, billId = BILL): Promise<number> {
  return (await getShares(db, billId)).find((s) => s.participant === who)!.owedCents;
}

async function settledAt(who: string): Promise<string | null> {
  const row = await db.prepare("SELECT settled_at FROM shares WHERE bill_id = ? AND participant_id = ?").bind(BILL, who).first<{ settled_at: string | null }>();
  return row!.settled_at;
}

async function renderedCard() {
  const snapshot = (await getBillSnapshot(db, BILL))!;
  return renderBill(snapshot.bill, splitBill(snapshot.input), snapshot.input.items, snapshot.participants, [], await getShares(db, BILL));
}

function cardRows(card: ReturnType<typeof renderBill>): string[] {
  return (card.embeds![0]!.description ?? "").split("\n");
}

describe("guests", () => {
  it("adds a guest scoped to one bill with no global identity", async () => {
    await seedSaigon(db, BILL);
    await seedSaigon(db, "bill-2", { bill: { channelId: "chan-2", messageId: "msg-2" } });

    const first = await addGuest("gavin", { name: "Sam", with: "dani" });
    const second = await addGuest("gavin", { name: "Sam", with: "dani" }, "bill-2");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const guest = first.body.participants.find((p: any) => p.kind === "guest");
    expect(guest).toMatchObject({ kind: "guest", displayName: "Sam", addedBy: "dani" });

    const one = (await getParticipants(db, BILL)).find((p) => p.kind === "guest")!;
    const two = (await getParticipants(db, "bill-2")).find((p) => p.kind === "guest")!;
    expect(one.id).toBe(guest.id);
    // Two guests called Sam on two bills are unrelated: nothing ties them.
    expect(one.id).not.toBe(two.id);
    expect(one.id).not.toMatch(/^\d+$/);
    expect(one.id).not.toBe("Sam");
  });

  it("bills a guest's share to the member who added them", async () => {
    // Dani adds Sam, Sam claims a 2000 item
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();

    const card = renderBill(
      (await getBill(db, BILL))!,
      splitBill((await getBillSnapshot(db, BILL))!.input),
      (await getBillSnapshot(db, BILL))!.input.items,
      await getParticipants(db, BILL),
      [],
      await getShares(db, BILL),
    );
    expect(JSON.stringify(card)).toContain("Dani, including Sam");

    const together = (await owedOf("dani")) + (await owedOf(sam));
    const rows = cardRows(card);
    const dani = rows.find((r) => r.includes("Dani, including Sam"))!;
    expect(dani).toContain(formatCents(together));
    // One amount for the pair: Sam has no row of their own.
    expect(rows.filter((r) => r.includes("Sam"))).toEqual([dani]);
    expect((await outstanding(db, BILL)).find((o) => o.participant === "dani")!.owedCents).toBe(together);
    expect((await outstanding(db, BILL)).some((o) => o.participant === sam)).toBe(false);
  });

  it("refuses a non-payer adding a guest", async () => {
    await seedSaigon(db, BILL);
    const before = (await getBill(db, BILL))!.revision;

    for (const as of ["marcus", "dani"]) {
      const reply = await addGuest(as, { name: "Sam", with: "dani" });
      expect(reply.status).toBe(403);
      expect(reply.body.error).toMatch(/Gavin/);
    }
    expect((await getParticipants(db, BILL)).some((p) => p.kind === "guest")).toBe(false);
    expect((await getBill(db, BILL))!.revision).toBe(before);
  });

  it("takes a guest's name trimmed, 1 to 40 characters, unlike anyone else's on the bill", async () => {
    await seedSaigon(db, BILL);

    for (const name of ["", "   ", "x".repeat(41), "dani", "  GAVIN "]) {
      const reply = await addGuest("gavin", { name, with: "dani" });
      expect(reply.status, JSON.stringify(name)).toBe(400);
      expect(reply.body.error.length).toBeGreaterThan(0);
    }
    expect((await addGuest("gavin", { name: "  Sam  ", with: "dani" })).status).toBe(200);
    expect((await addGuest("gavin", { name: "sAM", with: "marcus" })).status).toBe(400);
    expect((await addGuest("gavin", { name: "y".repeat(40), with: "marcus" })).status).toBe(200);

    const guests = (await getParticipants(db, BILL)).filter((p) => p.kind === "guest");
    expect(guests.map((g) => g.displayName)).toEqual(["Sam", "y".repeat(40)]);
  });

  it("adds a guest only with a member of the roster, in the exact request shape", async () => {
    await seedSaigon(db, BILL);
    const sam = (await addGuest("gavin", { name: "Sam", with: "dani" })).body.participants.find((p: any) => p.kind === "guest").id;

    const refused = [
      { name: "Kim", with: sam },
      { name: "Kim", with: "zoe" },
      { name: "Kim" },
      { name: "Kim", with: "dani", extra: 1 },
      { name: 42, with: "dani" },
    ];
    for (const body of refused) {
      const reply = await addGuest("gavin", body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
    }
    expect((await getParticipants(db, BILL)).filter((p) => p.kind === "guest")).toHaveLength(1);
  });

  it("refuses a guest on a bill that is no longer a draft", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await addGuest("gavin", { name: "Sam", with: "dani" });

    expect(reply.status).toBe(409);
    expect(reply.body.error).toMatch(/confirmed/i);
    expect((await getParticipants(db, BILL)).some((p) => p.kind === "guest")).toBe(false);
  });

  it("asks a member for their guest's share too, in Pay my share and I paid", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    await db
      .prepare("INSERT INTO payment_handles (user_id, method, handle, updated_at) VALUES ('gavin', 'venmo', 'gavin-lin', '2026-10-28')")
      .run();
    const together = (await owedOf("dani")) + (await owedOf(sam));
    await recordSettlement(db, BILL, "dani", 1000, "dani");
    const left = together - 1000;

    const pay = await run(tap(`pay:${BILL}`, DANI));
    expect(pay.data.flags).toBe(EPHEMERAL);
    expect(pay.data.content).toContain(formatCents(left));
    expect(pay.data.content).toContain("Sam");
    const venmo = (pay.data.components[0].components as any[]).find((c) => c.style === 5);
    expect(new URL(venmo.url).searchParams.get("amount")).toBe(formatCents(left).slice(1));

    const paid = await run(tap(`paid:${BILL}`, DANI));
    expect(paid.data.content).toContain(formatCents(left));
    expect(customIds(paid.data)).toEqual([`paidall:${BILL}:${left}`, `paidpart:${BILL}`]);

    const all = await run(tap(`paidall:${BILL}:${left}`, DANI));
    expect(all.data.content).toMatch(/paid up/i);
    expect((await listSettlements(db, BILL)).every((s) => s.participant === "dani")).toBe(true);
    // Clear is the pair's: both rows settle when Dani's payments cover both.
    expect(await settledAt("dani")).not.toBeNull();
    expect(await settledAt(sam)).not.toBeNull();
  });

  it("never records a payment against a guest", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();

    await expect(recordSettlement(db, BILL, sam, 100, "gavin")).rejects.toMatchObject({ reason: "no-share" });
    expect(await listSettlements(db, BILL)).toEqual([]);
  });

  it("never lists a guest in /ledger, and rolls their share into their companion's", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    const together = (await owedOf("dani")) + (await owedOf(sam));

    const rows = await ledger(db, "gavin");
    expect(rows.some((r) => r.participant === sam)).toBe(false);
    expect(rows.find((r) => r.participant === "dani")!.owedCents).toBe(together);

    const reply = await run(ledgerCommand(GAVIN));
    expect(reply.data.content).not.toContain("Sam");
    expect(reply.data.content.split("\n").find((l: string) => l.includes("Dani"))).toContain(formatCents(together));
  });

  it("lets the payer absorb the share of a guest who came with them", async () => {
    await seedSaigon(db, BILL);
    const kim = await withGuest("Kim", "gavin");
    await confirmed();

    expect((await outstanding(db, BILL)).map((o) => o.participant)).not.toContain(kim);
    expect((await ledger(db, "gavin")).map((r) => r.participant)).not.toContain(kim);
    const card = await renderedCard();
    const row = cardRows(card).find((r) => r.includes("Gavin, including Kim"))!;
    expect(row).toContain(formatCents((await owedOf("gavin")) + (await owedOf(kim))));
    expect(row).toMatch(/paid the bill/);

    const page = await send("GET", `/b/${BILL}/state`, "gavin");
    const others = (await getShares(db, BILL))
      .filter((s) => s.participant !== "gavin" && s.participant !== kim)
      .reduce((sum, s) => sum + s.owedCents, 0);
    expect(page.body.payerCollectsCents).toBe(others);

    const refused = await pardon("gavin", kim);
    expect(refused.status).toBe(400);
  });

  it("shows a member their guest's lines in a separate block in Show my math", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();

    const reply = await run(tap(`math:${BILL}`, DANI));
    const text: string = reply.data.content;
    expect(reply.data.flags).toBe(EPHEMERAL);
    const block = text.indexOf("Sam");
    expect(block).toBeGreaterThan(text.indexOf("Garlic noodles"));
    expect(text.slice(block)).toContain("Lobster");
    expect(text.slice(0, block)).not.toContain("Lobster");
    expect(text).toContain(formatCents(await owedOf(sam)));
    expect(text).toContain(formatCents((await owedOf("dani")) + (await owedOf(sam))));
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it("says out loud how a pair's amount moved when the bill is confirmed again", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    await recordSettlement(db, BILL, "dani", 1000, "dani");
    const was = (await owedOf("dani")) + (await owedOf(sam));

    expect(await reopenBill(db, BILL)).toEqual([]);
    await editItem(db, BILL, `${BILL}-lobster-Sam`, { cents: 3000 });
    await setBillAmounts(db, BILL, { printedTotalCents: WITH_LOBSTER + 1000 });
    const reply = await run(tap(`confirm:${BILL}:${(await getBill(db, BILL))!.revision}`, GAVIN));

    const now = (await owedOf("dani")) + (await owedOf(sam));
    expect(now).not.toBe(was);
    expect(reply.data.flags ?? 0).toBe(0);
    expect(reply.data.content).toContain(`Dani paid $10.00 and now owes ${formatCents(now)}`);
    expect(reply.data.content).not.toContain("Sam paid");
  });
});

describe("pardons", () => {
  it("absorbs a pardon into the payer without moving anyone else", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    const before = await getShares(db, BILL);
    const collects = (await send("GET", `/b/${BILL}/state`, "gavin")).body.payerCollectsCents;

    const reply = await pardon("gavin", "marcus");

    expect(reply.status).toBe(200);
    const after = await getShares(db, BILL);
    expect(after.map((s) => [s.participant, s.owedCents])).toEqual(before.map((s) => [s.participant, s.owedCents]));
    expect(after.filter((s) => s.pardoned).map((s) => s.participant)).toEqual(["marcus"]);
    expect(reply.body.payerCollectsCents).toBe(collects - 4446);
    expect((await outstanding(db, BILL)).find((o) => o.participant === "marcus")!.owedCents).toBe(0);

    const [edit] = messageEdits();
    const marcusRow = (edit!.body.embeds[0].description as string).split("\n").find((l) => l.includes("<@marcus>"))!;
    expect(marcusRow).toMatch(/forgiven/);
    expect(edit!.body.embeds[0].description.match(/forgiven/g)).toHaveLength(1);
  });

  it("refuses a pardon on a draft bill", async () => {
    // Pardons apply to confirmed amounts.
    await seedSaigon(db, BILL);

    const reply = await pardon("gavin", "marcus");

    expect(reply.status).toBe(409);
    expect(reply.body.error).toMatch(/confirm/i);
    expect(await getShares(db, BILL)).toEqual([]);
  });

  it("refuses a pardon from anyone but the payer", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    for (const as of ["marcus", "dani"]) {
      const reply = await pardon(as, "marcus");
      expect(reply.status).toBe(403);
      expect(reply.body.error).toMatch(/Gavin/);
    }
    expect((await getShares(db, BILL)).some((s) => s.pardoned)).toBe(false);
  });

  it("refuses to pardon the payer's own share", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await pardon("gavin", "gavin");

    expect(reply.status).toBe(400);
    expect((await getShares(db, BILL)).some((s) => s.pardoned)).toBe(false);
  });

  it("refuses to pardon someone who has paid, or a guest whose companion has", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 1000, "marcus");
    await recordSettlement(db, BILL, "dani", 500, "dani");

    for (const who of ["marcus", sam, "dani"]) {
      const reply = await pardon("gavin", who);
      expect(reply.status, who).toBe(409);
      expect(reply.body.error).toMatch(/undo/i);
    }
    expect((await getShares(db, BILL)).some((s) => s.pardoned)).toBe(false);
  });

  it("re-derives settled_at when a pardon lands and when it is taken back", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    expect(await settledAt("marcus")).toBeNull();

    expect((await pardon("gavin", "marcus")).status).toBe(200);
    expect(await settledAt("marcus")).not.toBeNull();
    expect(await settledAt("jess")).toBeNull();

    const back = await pardon("gavin", "marcus", false);
    expect(back.status).toBe(200);
    expect(await settledAt("marcus")).toBeNull();
    expect((await getShares(db, BILL)).some((s) => s.pardoned)).toBe(false);
    expect((await outstanding(db, BILL)).find((o) => o.participant === "marcus")!.owedCents).toBe(4446);
  });

  it("forgives a guest's share alone, leaving their companion's", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();

    expect((await pardon("gavin", sam)).status).toBe(200);

    expect((await outstanding(db, BILL)).find((o) => o.participant === "dani")!.owedCents).toBe(await owedOf("dani"));
    const row = cardRows(await renderedCard()).find((r) => r.includes("Dani, including Sam"))!;
    expect(row).toContain(formatCents(await owedOf("dani")));
    expect(row).toMatch(/Sam forgiven/);
  });

  it("shows the pardon in Show my math", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    await pardon("gavin", "marcus");
    await pardon("gavin", sam);

    const marcus = (await run(tap(`math:${BILL}`, MARCUS))).data.content as string;
    // Sam's lobster moves everyone's tax and tip slice, so Marcus owes less than the plain Saigon $44.46.
    expect(marcus).toContain(`Gavin forgave your ${formatCents(await owedOf("marcus"))}`);

    const dani = (await run(tap(`math:${BILL}`, DANI))).data.content as string;
    expect(dani).toMatch(new RegExp(`Gavin forgave Sam's \\${formatCents(await owedOf(sam))}`));
    expect(dani).toContain(formatCents(await owedOf("dani")));
  });

  // An edit to the owe card notifies nobody, so a forgiven amount (or one
  // brought back) is also said in the channel, in both directions.
  it("says out loud in the channel when a share is forgiven and when that is taken back", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    expect((await pardon("gavin", "marcus")).status).toBe(200);
    expect((await pardon("gavin", "marcus", false)).status).toBe(200);

    const posts = channelPosts();
    expect(posts.map((p) => p.body)).toEqual([
      {
        content: "Gavin forgave Marcus's $44.46 for Saigon Kitchen, Oct 28, 2026, so Marcus owes nothing.",
        allowed_mentions: { parse: [] },
      },
      {
        content: "Gavin took back forgiving Marcus's $44.46 for Saigon Kitchen, Oct 28, 2026, so Marcus owes $44.46 again.",
        allowed_mentions: { parse: [] },
      },
    ]);
    expect(posts.map((p) => p.authorization)).toEqual(["Bot bot-token", "Bot bot-token"]);
  });

  it("names a guest's companion and says what the pair owes after a guest's pardon", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    const samOwes = formatCents(await owedOf(sam));
    const daniOwes = formatCents(await owedOf("dani"));
    const together = formatCents((await owedOf("dani")) + (await owedOf(sam)));

    expect((await pardon("gavin", sam)).status).toBe(200);
    expect((await pardon("gavin", "dani")).status).toBe(200);
    expect((await pardon("gavin", sam, false)).status).toBe(200);
    expect((await pardon("gavin", "dani", false)).status).toBe(200);

    const bill = "Saigon Kitchen, Oct 28, 2026";
    expect(channelPosts().map((p) => p.body.content)).toEqual([
      `Gavin forgave Sam's ${samOwes} for ${bill}, so Dani, including Sam, owes ${daniOwes}.`,
      `Gavin forgave Dani's ${daniOwes} for ${bill}, so Dani, including Sam, owes nothing.`,
      // Dani's own share is still forgiven, so this is not what the pair owed before.
      `Gavin took back forgiving Sam's ${samOwes} for ${bill}, so Dani, including Sam, owes ${samOwes}.`,
      `Gavin took back forgiving Dani's ${daniOwes} for ${bill}, so Dani, including Sam, owes ${together} again.`,
    ]);
    expect(channelPosts().every((p) => JSON.stringify(p.body.allowed_mentions) === JSON.stringify({ parse: [] }))).toBe(true);
  });

  it("posts nothing to the channel when a pardon is refused", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    await recordSettlement(db, BILL, "dani", 500, "dani");

    expect((await pardon("marcus", "jess")).status).toBe(403);
    expect((await pardon("gavin", "gavin")).status).toBe(400);
    expect((await pardon("gavin", sam)).status).toBe(409);
    expect((await pardon("gavin", "zoe")).status).toBe(400);
    await reopenBill(db, BILL);
    expect((await pardon("gavin", "marcus")).status).toBe(409);

    expect(channelPosts()).toEqual([]);
  });

  it("asks for nothing in Pay my share once the whole pair is forgiven", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    await pardon("gavin", "dani");

    const partly = await run(tap(`pay:${BILL}`, DANI));
    expect(partly.data.content).toContain(formatCents(await owedOf(sam)));

    await pardon("gavin", sam);
    const covered = await run(tap(`pay:${BILL}`, DANI));
    expect(covered.data.content).toMatch(/Gavin covered your share/);
  });
});

describe("the page", () => {
  it("offers the payer a guest form on a draft, listing only members to come with", async () => {
    await seedSaigon(db, BILL);
    await addGuest("gavin", { name: "Sam", with: "dani" });
    const snapshot = (await getBillSnapshot(db, BILL))!;
    const html = renderPage(snapshot.bill, splitBill(snapshot.input), snapshot.input.items, snapshot.participants, "gavin");

    const form = await one(html, "form[data-guest-form]");
    expect("hidden" in form.attrs).toBe(false);
    const options = await select(html, "form[data-guest-form] select option");
    const values = options.map((o) => o.attrs.value).filter(Boolean);
    expect(values).toEqual(snapshot.participants.filter((p) => p.kind === "member").map((p) => p.id));
    expect(await select(html, "form[data-guest-form] input[name=name][maxlength='40']")).toHaveLength(1);

    const diner = renderPage(snapshot.bill, splitBill(snapshot.input), snapshot.input.items, snapshot.participants, "marcus");
    expect(await select(diner, "form[data-guest-form]")).toEqual([]);
  });

  it("gives the payer a forgive toggle per person on a confirmed bill, off for anyone who has paid", async () => {
    await seedSaigon(db, BILL);
    const kim = await withGuest("Kim", "gavin");
    await confirmed();
    await recordSettlement(db, BILL, "jess", 100, "jess");
    await pardon("gavin", "marcus");

    const link = `/b/${BILL}?t=${await mintToken(BILL, "gavin", KEY, Date.now())}`;
    const response = await app.fetch(new Request(`https://aazhi.test${link}`), env(), createExecutionContext());
    const html = await response.text();

    const toggles = await select(html, "button[data-forgive]");
    const ids = toggles.map((t) => t.attrs["data-forgive"]);
    expect(ids).not.toContain("gavin");
    expect(ids).not.toContain(kim);
    expect(ids).toEqual(expect.arrayContaining(["marcus", "jess", "dani"]));
    const by = (id: string) => toggles.find((t) => t.attrs["data-forgive"] === id)!;
    expect(by("marcus").attrs["aria-pressed"]).toBe("true");
    expect(by("dani").attrs["aria-pressed"]).toBe("false");
    expect("disabled" in by("jess").attrs).toBe(true);
    expect("disabled" in by("dani").attrs).toBe(false);
    expect(await select(html, "form[data-guest-form]:not([hidden])")).toEqual([]);

    const diner = await app.fetch(
      new Request(`https://aazhi.test/b/${BILL}?t=${await mintToken(BILL, "marcus", KEY, Date.now())}`),
      env(),
      createExecutionContext(),
    );
    expect(await select(await diner.text(), "button[data-forgive]")).toEqual([]);
  });
});
