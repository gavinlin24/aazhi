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
const SAIGON_KITCHEN = "Saigon Kitchen, Oct 28, 2026";

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

function rename(as: string, guestId: string, name: unknown) {
  return send("PATCH", `/b/${BILL}/guest/${guestId}`, as, { name });
}

function takeOff(as: string, guestId: string) {
  return send("DELETE", `/b/${BILL}/guest/${guestId}`, as);
}

function markPaid(as: string, guestId: string, paid = true) {
  return send("POST", `/b/${BILL}/guest/${guestId}/paid`, as, { paid });
}

function pardon(as: string, participantId: string, pardoned = true, billId = BILL) {
  return send("POST", `/b/${billId}/pardon`, as, { participantId, pardoned });
}

function claimFor(as: string, itemId: string, participantId: string, billId = BILL) {
  return send("POST", `/b/${billId}/claim`, as, { itemId, participantId, claimed: true });
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

// The payer picking one payment from the Undo a payment menu.
function undoPick(settlementId: string) {
  return { ...tap(`undopick:${BILL}`, GAVIN), data: { custom_id: `undopick:${BILL}`, component_type: 3, values: [settlementId] } };
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

async function revision(): Promise<number> {
  return (await getBill(db, BILL))!.revision;
}

function guestIdOf(reply: Reply, name: string): string {
  return reply.body.participants.find((p: any) => p.kind === "guest" && p.displayName === name).id;
}

// Dani brought Sam, who had the lobster. Dani puts Sam on the bill, which
// makes Sam Dani's to answer for, and taps Sam onto the lobster.
async function withGuest(name = "Sam", adder = "dani", billId = BILL): Promise<string> {
  const reply = await addGuest(adder, { name }, billId);
  expect(reply.status).toBe(200);
  const guest = guestIdOf(reply, name);
  const item = `${billId}-lobster-${name}`;
  await addItem(db, billId, { id: item, label: "Lobster", cents: 2000, source: "manual" });
  const printed = (await getBill(db, billId))!.printedTotalCents!;
  await setBillAmounts(db, billId, { printedTotalCents: printed + 2000 });
  const claim = await claimFor(adder, item, guest, billId);
  expect(claim.status).toBe(200);
  return guest;
}

async function owedOf(who: string, billId = BILL): Promise<number> {
  return (await getShares(db, billId)).find((s) => s.participant === who)!.owedCents;
}

async function standing(who: string) {
  return (await outstanding(db, BILL)).find((o) => o.participant === who);
}

async function settledAt(who: string): Promise<string | null> {
  const row = await db.prepare("SELECT settled_at FROM shares WHERE bill_id = ? AND participant_id = ?").bind(BILL, who).first<{ settled_at: string | null }>();
  return row!.settled_at;
}

async function renderedCard() {
  const snapshot = (await getBillSnapshot(db, BILL))!;
  return renderBill(snapshot.bill, splitBill(snapshot.input), snapshot.input.items, snapshot.participants, await getShares(db, BILL));
}

function cardRows(card: ReturnType<typeof renderBill>): string[] {
  return (card.embeds![0]!.description ?? "").split("\n");
}

function inState(body: any, id: string): any {
  return body.participants.find((p: any) => p.id === id);
}

describe("adding a guest", () => {
  it("adds a guest scoped to one bill with no global identity", async () => {
    await seedSaigon(db, BILL);
    await seedSaigon(db, "bill-2", { bill: { channelId: "chan-2", messageId: "msg-2" } });

    const first = await addGuest("dani", { name: "Sam" });
    const second = await addGuest("dani", { name: "Sam" }, "bill-2");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const guest = first.body.participants.find((p: any) => p.kind === "guest");
    expect(guest).toMatchObject({ kind: "guest", displayName: "Sam", addedBy: "dani", paidToPayer: false, paidToHost: false });

    const one = (await getParticipants(db, BILL)).find((p) => p.kind === "guest")!;
    const two = (await getParticipants(db, "bill-2")).find((p) => p.kind === "guest")!;
    expect(one.id).toBe(guest.id);
    // Two guests called Sam on two bills are unrelated: nothing ties them.
    expect(one.id).not.toBe(two.id);
    expect(one.id).not.toMatch(/^\d+$/);
    expect(one.id).not.toBe("Sam");
  });

  it("lets anyone on the bill add a guest, who is then theirs", async () => {
    await seedSaigon(db, BILL);

    for (const [as, name] of [
      ["marcus", "Kim"],
      ["gavin", "Lee"],
      ["dani", "Sam"],
    ] as const) {
      expect((await addGuest(as, { name })).status, as).toBe(200);
    }

    const guests = (await getParticipants(db, BILL)).filter((p) => p.kind === "guest");
    expect(guests.map((g) => [g.displayName, g.addedBy]).sort()).toEqual([
      ["Kim", "marcus"],
      ["Lee", "gavin"],
      ["Sam", "dani"],
    ]);
  });

  it("refuses a guest from anyone who isn't a member on the bill", async () => {
    await seedSaigon(db, BILL);
    const sam = guestIdOf(await addGuest("dani", { name: "Sam" }), "Sam");
    const before = await revision();

    for (const as of ["zoe", sam]) {
      const reply = await addGuest(as, { name: "Kim" });
      expect(reply.status, as).toBe(403);
      expect(reply.body.error).toMatch(/not on this bill/);
    }
    expect((await getParticipants(db, BILL)).filter((p) => p.kind === "guest").map((g) => g.displayName)).toEqual(["Sam"]);
    expect(await revision()).toBe(before);
  });

  it("takes a guest's name trimmed, 1 to 40 characters, unlike anyone else's on the bill", async () => {
    await seedSaigon(db, BILL);

    for (const name of ["", "   ", "x".repeat(41), "dani", "  GAVIN "]) {
      const reply = await addGuest("dani", { name });
      expect(reply.status, JSON.stringify(name)).toBe(400);
      expect(reply.body.error.length).toBeGreaterThan(0);
    }
    expect((await addGuest("dani", { name: "  Sam  " })).status).toBe(200);
    expect((await addGuest("marcus", { name: "sAM" })).status).toBe(400);
    expect((await addGuest("marcus", { name: "y".repeat(40) })).status).toBe(200);

    const guests = (await getParticipants(db, BILL)).filter((p) => p.kind === "guest");
    expect(guests.map((g) => g.displayName).sort()).toEqual(["Sam", "y".repeat(40)]);
  });

  it("takes only a name, so a request still saying who the guest came with is refused", async () => {
    await seedSaigon(db, BILL);

    for (const body of [{ name: "Kim", with: "dani" }, {}, { name: 42 }, { name: "Kim", extra: 1 }]) {
      const reply = await addGuest("dani", body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
    }
    expect((await getParticipants(db, BILL)).some((p) => p.kind === "guest")).toBe(false);
  });

  it("refuses a guest on a bill that is no longer a draft", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await addGuest("dani", { name: "Sam" });

    expect(reply.status).toBe(409);
    expect(reply.body.error).toMatch(/confirmed/i);
    expect((await getParticipants(db, BILL)).some((p) => p.kind === "guest")).toBe(false);
  });
});

describe("tapping a guest onto lines", () => {
  it("lets whoever added a guest tap them on, and the payer, but nobody else", async () => {
    await seedSaigon(db, BILL);
    const sam = guestIdOf(await addGuest("dani", { name: "Sam" }), "Sam");
    const kim = guestIdOf(await addGuest("marcus", { name: "Kim" }), "Kim");
    await addItem(db, BILL, { id: "lobster", label: "Lobster", cents: 2000, source: "manual" });
    await addItem(db, BILL, { id: "fries", label: "Fries", cents: 700, source: "manual" });

    expect((await claimFor("dani", "lobster", sam)).status).toBe(200);
    expect((await claimFor("gavin", "fries", sam)).status).toBe(200);
    expect((await claimFor("marcus", "fries", kim)).status).toBe(200);
    for (const [as, guest] of [
      ["marcus", sam],
      ["dani", kim],
    ] as const) {
      const refused = await claimFor(as, "lobster", guest);
      expect(refused.status, as).toBe(403);
      expect(refused.body.error).toBe("Only Gavin can tap other people onto a line. Tap your own chip for what you had, or a guest's you added.");
    }

    const items = (await getBillSnapshot(db, BILL))!.input.items;
    expect(items.find((i) => i.id === "lobster")!.claimedBy).toEqual([sam]);
    expect([...items.find((i) => i.id === "fries")!.claimedBy].sort()).toEqual([sam, kim].sort());
  });
});

describe("renaming and taking off a guest", () => {
  it("lets whoever added a guest or the payer rename them, and nobody else", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();

    expect((await rename("dani", sam, "Sammy")).status).toBe(200);
    const byPayer = await rename("gavin", sam, "  Sam L ");
    expect(byPayer.status).toBe(200);
    expect(inState(byPayer.body, sam)).toMatchObject({ displayName: "Sam L", addedBy: "dani" });

    const before = await revision();
    const refused = await rename("marcus", sam, "Nope");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("Only Dani, who added Sam L, or Gavin can rename them.");
    expect(await revision()).toBe(before);
    expect((await getParticipants(db, BILL)).find((p) => p.id === sam)!.displayName).toBe("Sam L");
  });

  it("holds a new name to the same rules, the guest's own name aside", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await addGuest("marcus", { name: "Kim" });

    for (const name of ["", "   ", "x".repeat(41), "marcus", "kim", 7]) {
      expect((await rename("dani", sam, name)).status, JSON.stringify(name)).toBe(400);
    }
    expect((await rename("dani", sam, "Kim")).body.error).toBe(
      "Kim is already on this bill. Give the guest a name that tells them apart, like one with an initial.",
    );
    expect((await send("PATCH", `/b/${BILL}/guest/${sam}`, "dani", { name: "Sammy", with: "dani" })).status).toBe(400);
    expect((await rename("dani", sam, "SAM")).status).toBe(200);
    expect((await getParticipants(db, BILL)).find((p) => p.id === sam)!.displayName).toBe("SAM");
  });

  it("takes a guest off with their lines, for whoever added them or the payer", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    const kim = await withGuest("Kim", "marcus");

    const refused = await takeOff("marcus", sam);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("Only Dani, who added Sam, or Gavin can take them off.");

    const before = await revision();
    const gone = await takeOff("dani", sam);
    expect(gone.status).toBe(200);
    expect(inState(gone.body, sam)).toBeUndefined();
    expect(await revision()).toBeGreaterThan(before);
    expect((await takeOff("gavin", kim)).status).toBe(200);

    expect((await getParticipants(db, BILL)).some((p) => p.kind === "guest")).toBe(false);
    const items = (await getBillSnapshot(db, BILL))!.input.items;
    expect(items.find((i) => i.id === `${BILL}-lobster-Sam`)!.claimedBy).toEqual([]);
    expect(items.find((i) => i.id === `${BILL}-lobster-Kim`)!.claimedBy).toEqual([]);
  });

  it("answers that the guest is gone for someone not on the bill, or a member", async () => {
    await seedSaigon(db, BILL);

    for (const id of ["guest-nobody", "marcus"]) {
      for (const reply of [await rename("gavin", id, "Kim"), await takeOff("gavin", id)]) {
        expect(reply.status, id).toBe(404);
        expect(reply.body.error).toBe("That guest isn't on this bill any more.");
      }
    }
    expect((await getParticipants(db, BILL)).find((p) => p.id === "marcus")!.displayName).toBe("Marcus");
  });

  it("changes a guest only while the bill is a draft", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();

    for (const reply of [await rename("dani", sam, "Sammy"), await takeOff("dani", sam)]) {
      expect(reply.status).toBe(409);
      expect(reply.body.error).toMatch(/confirmed/i);
    }
    expect((await getParticipants(db, BILL)).find((p) => p.id === sam)!.displayName).toBe("Sam");
  });

  it("keeps a guest on a reopened bill while a payment counts toward what they owe", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    const kim = await withGuest("Kim", "marcus");
    await confirmed();
    await recordSettlement(db, BILL, "dani", 500, "dani");
    await reopenBill(db, BILL);

    const refused = await takeOff("dani", sam);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(
      "There's already a payment toward Sam's share on this bill, so they can't be taken off now. " +
        "Take Sam off their lines instead, and their share drops to nothing.",
    );
    expect((await getParticipants(db, BILL)).some((p) => p.id === sam)).toBe(true);
    // Marcus has paid nothing, so his guest can go.
    expect((await takeOff("marcus", kim)).status).toBe(200);
    expect((await getParticipants(db, BILL)).some((p) => p.id === kim)).toBe(false);
  });
});

describe("a guest another member added", () => {
  it("bills the guest's share to the member who added them", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();

    const card = await renderedCard();
    const together = (await owedOf("dani")) + (await owedOf(sam));
    const rows = cardRows(card);
    const dani = rows.find((r) => r.includes("Dani, including Sam"))!;
    expect(dani).toContain(formatCents(together));
    // One amount for the pair: Sam has no row of their own.
    expect(rows.filter((r) => r.includes("Sam"))).toEqual([dani]);
    expect((await standing("dani"))!.owedCents).toBe(together);
    expect(await standing(sam)).toBeUndefined();
  });

  it("asks the member for their guest's share too, in Pay my share and I paid", async () => {
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

  it("never takes an I paid payment for a guest, who has no Discord account", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();

    await expect(recordSettlement(db, BILL, sam, 100, "gavin")).rejects.toMatchObject({ reason: "no-share" });
    expect(await listSettlements(db, BILL)).toEqual([]);
  });

  it("never lists the guest in /ledger, and rolls their share into the member's", async () => {
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

  it("shows the member their guest's lines in a separate block in Show my math", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();

    const reply = await run(tap(`math:${BILL}`, DANI));
    const text: string = reply.data.content;
    expect(reply.data.flags).toBe(EPHEMERAL);
    const block = text.indexOf("**Sam, your guest**");
    expect(block).toBeGreaterThan(text.indexOf("Garlic noodles"));
    expect(text.slice(block)).toContain("Lobster");
    expect(text.slice(0, block)).not.toContain("Lobster");
    expect(text).toContain(formatCents(await owedOf(sam)));
    expect(text).toContain(formatCents((await owedOf("dani")) + (await owedOf(sam))));
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it("says out loud how the member's amount moved when the bill is confirmed again", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    await recordSettlement(db, BILL, "dani", 1000, "dani");
    const was = (await owedOf("dani")) + (await owedOf(sam));

    expect(await reopenBill(db, BILL)).toEqual([]);
    await editItem(db, BILL, `${BILL}-lobster-Sam`, { cents: 3000 });
    await setBillAmounts(db, BILL, { printedTotalCents: 27382 + 3000 });
    const reply = await run(tap(`confirm:${BILL}:${await revision()}`, GAVIN));

    const now = (await owedOf("dani")) + (await owedOf(sam));
    expect(now).not.toBe(was);
    expect(reply.data.flags ?? 0).toBe(0);
    expect(reply.data.content).toContain(`Dani paid $10.00 and now owes ${formatCents(now)}`);
    expect(reply.data.content).not.toContain("Sam paid");
  });
});

describe("a guest the payer added", () => {
  it("owes the payer directly, with a row of their own everywhere", async () => {
    await seedSaigon(db, BILL);
    const kim = await withGuest("Kim", "gavin");
    await confirmed();
    const kimOwes = await owedOf(kim);

    expect(await standing(kim)).toEqual({ participant: kim, owedCents: kimOwes, settledCents: 0 });
    expect((await ledger(db, "gavin")).find((r) => r.participant === kim)).toEqual({
      participant: kim,
      displayName: "Kim",
      kind: "guest",
      place: "Saigon Kitchen",
      owedCents: kimOwes,
      settledCents: 0,
      billCount: 1,
    });
    const lines: string[] = (await run(ledgerCommand(GAVIN))).data.content.split("\n");
    expect(lines.filter((l) => l.includes("Kim"))).toEqual([`- Kim: ${formatCents(kimOwes)} (your guest at Saigon Kitchen)`]);

    const rows = cardRows(await renderedCard());
    expect(rows.filter((r) => r.includes("Kim"))).toEqual([`Kim (guest) · ${formatCents(kimOwes)}`]);
    // The payer collects; their own share is owed to nobody, so it has no row.
    expect(rows.some((r) => r.startsWith("<@gavin>"))).toBe(false);
    expect(rows).toContain("🪙 Pay <@gavin> your share.");

    const state = await send("GET", `/b/${BILL}/state`, "gavin");
    const others = (await getShares(db, BILL)).filter((s) => s.participant !== "gavin").reduce((sum, s) => sum + s.owedCents, 0);
    expect(state.body.payerCollectsCents).toBe(others);
    expect(inState(state.body, kim)).toMatchObject({ addedBy: "gavin", paidToPayer: false, paidToHost: false });
  });

  it("tells the payer only their own part in Pay my share", async () => {
    await seedSaigon(db, BILL);
    await withGuest("Kim", "gavin");
    await confirmed();

    const pay = await run(tap(`pay:${BILL}`, GAVIN));
    expect(pay.data.content).toContain(`Your own part of it was ${formatCents(await owedOf("gavin"))}.`);
    expect(pay.data.content).not.toContain("Kim");
  });

  it("can be forgiven like anyone else who owes the payer", async () => {
    await seedSaigon(db, BILL);
    const kim = await withGuest("Kim", "gavin");
    await confirmed();
    const kimOwes = formatCents(await owedOf(kim));

    expect((await pardon("gavin", kim)).status).toBe(200);

    expect((await standing(kim))!.owedCents).toBe(0);
    expect(cardRows(await renderedCard()).filter((r) => r.includes("Kim"))).toEqual([`Kim (guest) · ~~${kimOwes}~~ forgiven`]);
    expect(channelPosts().map((p) => p.body.content)).toEqual([`Gavin forgave Kim's ${kimOwes} for ${SAIGON_KITCHEN}, so Kim owes nothing.`]);
  });

  it("is marked paid by the payer, as the guest paying the payer", async () => {
    await seedSaigon(db, BILL);
    const kim = await withGuest("Kim", "gavin");
    await confirmed();
    const cents = await owedOf(kim);

    const paid = await markPaid("gavin", kim);

    expect(paid.status).toBe(200);
    expect(inState(paid.body, kim)).toMatchObject({ paidToPayer: true, paidToHost: false });
    expect(await listSettlements(db, BILL)).toMatchObject([{ participant: kim, cents, recordedBy: "gavin" }]);
    expect(await standing(kim)).toEqual({ participant: kim, owedCents: cents, settledCents: cents });
    expect(await settledAt(kim)).not.toBeNull();
    expect((await ledger(db, "gavin")).some((r) => r.participant === kim)).toBe(false);

    const back = await markPaid("gavin", kim, false);
    expect(back.status).toBe(200);
    expect(inState(back.body, kim)).toMatchObject({ paidToPayer: false, paidToHost: false });
    expect(await listSettlements(db, BILL)).toEqual([]);
    expect(await settledAt(kim)).toBeNull();

    expect(channelPosts().map((p) => p.body)).toEqual([
      { content: `Kim paid Gavin ${formatCents(cents)} for ${SAIGON_KITCHEN}. Kim is all paid up.`, allowed_mentions: { parse: [] } },
      {
        content: `Gavin removed Kim's ${formatCents(cents)} payment on ${SAIGON_KITCHEN}. Kim has ${formatCents(cents)} left to pay.`,
        allowed_mentions: { parse: [] },
      },
    ]);
  });

  it("is the payer's alone to change or mark paid", async () => {
    await seedSaigon(db, BILL);
    const kim = await withGuest("Kim", "gavin");

    expect((await rename("dani", kim, "Kimberly")).body.error).toBe("Only Gavin, who added Kim, can rename them.");
    expect((await claimFor("dani", `${BILL}-lobster-Kim`, kim)).status).toBe(403);
    await confirmed();
    const refused = await markPaid("dani", kim);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("Only Gavin, who added Kim, can mark them paid.");
    expect(await listSettlements(db, BILL)).toEqual([]);
  });
});

describe("marking a guest paid", () => {
  it("takes what a guest paid the payer directly off what the member who added them owes", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    const samOwes = await owedOf(sam);
    const daniOwes = await owedOf("dani");
    const before = await revision();

    const reply = await markPaid("gavin", sam);

    expect(reply.status).toBe(200);
    expect(inState(reply.body, sam)).toMatchObject({ addedBy: "dani", paidToPayer: true, paidToHost: false });
    expect(await revision()).toBe(before + 1);
    expect(await listSettlements(db, BILL)).toMatchObject([{ participant: sam, cents: samOwes, recordedBy: "gavin" }]);
    expect(await standing("dani")).toEqual({ participant: "dani", owedCents: daniOwes, settledCents: 0 });
    expect((await ledger(db, "gavin")).find((r) => r.participant === "dani")).toMatchObject({ owedCents: daniOwes, settledCents: 0 });
    expect(channelPosts().map((p) => p.body)).toEqual([
      {
        content: `Sam paid Gavin ${formatCents(samOwes)} directly for ${SAIGON_KITCHEN}. Dani has ${formatCents(daniOwes)} left to pay.`,
        allowed_mentions: { parse: [] },
      },
    ]);

    const pay = (await run(tap(`pay:${BILL}`, DANI))).data.content as string;
    expect(pay).toContain(`You owe Gavin **${formatCents(daniOwes)}** for ${SAIGON_KITCHEN}.`);
    expect(pay).toContain("Sam paid Gavin directly, so that share is off your total.");
    const math = (await run(tap(`math:${BILL}`, DANI))).data.content as string;
    expect(math).toContain(`Sam paid Gavin ${formatCents(samOwes)} directly, so that's off your total.`);
    expect(math).toContain(`= ${formatCents(daniOwes)}**`);
    const paid = await run(tap(`paid:${BILL}`, DANI));
    expect(customIds(paid.data)).toEqual([`paidall:${BILL}:${daniOwes}`, `paidpart:${BILL}`]);

    await run(tap(`paidall:${BILL}:${daniOwes}`, DANI));
    expect(await settledAt("dani")).not.toBeNull();
    expect(await settledAt(sam)).not.toBeNull();
  });

  it("puts the guest's share back on the member when the payer takes the mark back", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    const samOwes = formatCents(await owedOf(sam));
    const together = (await owedOf("dani")) + (await owedOf(sam));
    await markPaid("gavin", sam);
    const before = await revision();

    const reply = await markPaid("gavin", sam, false);

    expect(reply.status).toBe(200);
    expect(inState(reply.body, sam)).toMatchObject({ paidToPayer: false, paidToHost: false });
    expect(await revision()).toBe(before + 1);
    expect(await listSettlements(db, BILL)).toEqual([]);
    expect(await standing("dani")).toEqual({ participant: "dani", owedCents: together, settledCents: 0 });
    expect(channelPosts().map((p) => p.body.content)[1]).toBe(
      `Gavin removed Sam's ${samOwes} payment on ${SAIGON_KITCHEN}. Dani has ${formatCents(together)} left to pay.`,
    );
  });

  it("keeps the member's mark between them and their guest, with no money moving", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    const together = (await owedOf("dani")) + (await owedOf(sam));
    const before = await revision();

    const reply = await markPaid("dani", sam);

    expect(reply.status).toBe(200);
    expect(inState(reply.body, sam)).toMatchObject({ paidToPayer: false, paidToHost: true });
    expect(await revision()).toBe(before + 1);
    expect(await listSettlements(db, BILL)).toEqual([]);
    expect(await standing("dani")).toEqual({ participant: "dani", owedCents: together, settledCents: 0 });
    expect(channelPosts()).toEqual([]);
    expect((await run(tap(`pay:${BILL}`, DANI))).data.content).toContain(`You owe Gavin **${formatCents(together)}**`);

    // The two marks are separate facts, so one never moves the other.
    expect(inState((await markPaid("gavin", sam)).body, sam)).toMatchObject({ paidToPayer: true, paidToHost: true });
    expect(inState((await markPaid("dani", sam, false)).body, sam)).toMatchObject({ paidToPayer: true, paidToHost: false });
    expect(await listSettlements(db, BILL)).toHaveLength(1);
  });

  it("changes nothing and posts nothing when the mark already says that", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    const start = await revision();

    expect((await markPaid("gavin", sam, false)).status).toBe(200);
    expect((await markPaid("dani", sam, false)).status).toBe(200);
    expect(await revision()).toBe(start);

    await markPaid("gavin", sam);
    await markPaid("dani", sam);
    const marked = await revision();
    expect((await markPaid("gavin", sam)).status).toBe(200);
    expect((await markPaid("dani", sam)).status).toBe(200);

    expect(await revision()).toBe(marked);
    expect(await listSettlements(db, BILL)).toHaveLength(1);
    expect(channelPosts()).toHaveLength(1);
  });

  it("refuses a mark from anyone but the member who added the guest and the payer", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();

    for (const as of ["marcus", "zoe"]) {
      const reply = await markPaid(as, sam);
      expect(reply.status, as).toBe(403);
      expect(reply.body.error).toBe("Only Dani, who added Sam, or Gavin can mark them paid.");
    }
    expect((await markPaid("gavin", "marcus")).status).toBe(404);
    expect(await listSettlements(db, BILL)).toEqual([]);
    expect(inState((await send("GET", `/b/${BILL}/state`, "dani")).body, sam)).toMatchObject({ paidToPayer: false, paidToHost: false });
  });

  it("marks a guest paid only on a confirmed bill", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();

    for (const as of ["gavin", "dani"]) {
      const reply = await markPaid(as, sam);
      expect(reply.status, as).toBe(409);
      expect(reply.body.error).toMatch(/isn't confirmed/);
    }
    await confirmed();
    await reopenBill(db, BILL);
    expect((await markPaid("gavin", sam)).status).toBe(409);
    expect(await listSettlements(db, BILL)).toEqual([]);
  });

  it("refuses a direct payment the member already paid, or one the payer forgave", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    const kim = await withGuest("Kim", "marcus");
    await confirmed();
    await recordSettlement(db, BILL, "dani", (await owedOf("dani")) + (await owedOf(sam)), "dani");
    await pardon("gavin", kim);

    const covered = await markPaid("gavin", sam);
    expect(covered.status).toBe(409);
    expect(covered.body.error).toBe(
      "Dani has already paid you Sam's share, so it can't be paid twice. " +
        "If Sam paid you instead, undo Dani's payment with Undo a payment in Discord first.",
    );
    const forgiven = await markPaid("gavin", kim);
    expect(forgiven.status).toBe(409);
    expect(forgiven.body.error).toBe("Gavin forgave Kim's share, so there's nothing for them to pay.");

    expect((await listSettlements(db, BILL)).map((s) => s.participant)).toEqual(["dani"]);
    expect(channelPosts().map((p) => p.body.content)).toEqual([expect.stringMatching(/^Gavin forgave Kim's/)]);
  });

  it("takes a direct payment on top of part of what the member paid", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    await recordSettlement(db, BILL, "dani", 1000, "dani");
    const daniOwes = await owedOf("dani");

    expect((await markPaid("gavin", sam)).status).toBe(200);

    expect(await standing("dani")).toEqual({ participant: "dani", owedCents: daniOwes, settledCents: 1000 });
    expect((await run(tap(`pay:${BILL}`, DANI))).data.content).toContain(
      `You have **${formatCents(daniOwes - 1000)}** left to pay Gavin for ${SAIGON_KITCHEN}: you've paid $10.00 of ${formatCents(daniOwes)}.`,
    );
  });

  it("refuses to forgive the member or their guest once the guest paid the payer", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    await markPaid("gavin", sam);

    for (const who of [sam, "dani"]) {
      const reply = await pardon("gavin", who);
      expect(reply.status, who).toBe(409);
      expect(reply.body.error).toMatch(/^There's already a payment toward what Dani owes on this bill/);
    }
    expect((await getShares(db, BILL)).some((s) => s.pardoned)).toBe(false);
  });

  it("tells the channel the member's balance when the payer undoes the guest's payment in Discord", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    const samOwes = formatCents(await owedOf(sam));
    const together = formatCents((await owedOf("dani")) + (await owedOf(sam)));
    await markPaid("gavin", sam);

    const menu = await run(tap(`undo:${BILL}`, GAVIN));
    const [option] = menu.data.components[0].components[0].options;
    expect(option.label).toBe(`Sam paid ${samOwes}`);
    expect(option.description).toMatch(/ by Gavin$/);

    const reply = await run(undoPick(option.value));
    expect(reply.data.content).toBe(`Gavin removed Sam's ${samOwes} payment on ${SAIGON_KITCHEN}. Dani has ${together} left to pay.`);
    expect(inState((await send("GET", `/b/${BILL}/state`, "dani")).body, sam)).toMatchObject({ paidToPayer: false });
  });

  it("nets a guest's direct payment out of the member's amount when the bill is confirmed again", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();
    await recordSettlement(db, BILL, "dani", 1000, "dani");
    await markPaid("gavin", sam);
    const direct = await owedOf(sam);

    await reopenBill(db, BILL);
    await editItem(db, BILL, `${BILL}-lobster-Sam`, { cents: 3000 });
    await setBillAmounts(db, BILL, { printedTotalCents: 27382 + 3000 });
    const reply = await run(tap(`confirm:${BILL}:${await revision()}`, GAVIN));

    const now = (await owedOf("dani")) + (await owedOf(sam)) - direct;
    expect(reply.data.content).toContain(`Dani paid $10.00 and now owes ${formatCents(now)}`);
    expect(reply.data.content).not.toContain("Sam paid");
  });

  it("reports both marks for every guest in the page state, and neither for members", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    const kim = await withGuest("Kim", "gavin");
    await confirmed();
    await markPaid("dani", sam);
    await markPaid("gavin", kim);

    const state = (await send("GET", `/b/${BILL}/state`, "marcus")).body;

    expect(inState(state, sam)).toMatchObject({ addedBy: "dani", paidToPayer: false, paidToHost: true });
    expect(inState(state, kim)).toMatchObject({ addedBy: "gavin", paidToPayer: true, paidToHost: false });
    for (const p of state.participants.filter((p: any) => p.kind === "member")) {
      expect(p, p.id).not.toHaveProperty("paidToPayer");
      expect(p, p.id).not.toHaveProperty("paidToHost");
    }
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
    expect((await standing("marcus"))!.owedCents).toBe(0);

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

  it("refuses to pardon someone who has paid, or a guest whose member has", async () => {
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
    expect((await standing("marcus"))!.owedCents).toBe(4446);
  });

  it("forgives a guest's share alone, leaving the member's own", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    await confirmed();

    expect((await pardon("gavin", sam)).status).toBe(200);

    expect((await standing("dani"))!.owedCents).toBe(await owedOf("dani"));
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
        content: `Gavin forgave Marcus's $44.46 for ${SAIGON_KITCHEN}, so Marcus owes nothing.`,
        allowed_mentions: { parse: [] },
      },
      {
        content: `Gavin took back forgiving Marcus's $44.46 for ${SAIGON_KITCHEN}, so Marcus owes $44.46 again.`,
        allowed_mentions: { parse: [] },
      },
    ]);
    expect(posts.map((p) => p.authorization)).toEqual(["Bot bot-token", "Bot bot-token"]);
  });

  it("posts nothing and leaves the revision alone when the flag already says that", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    expect((await pardon("gavin", "marcus")).status).toBe(200);
    const before = await revision();

    expect((await pardon("gavin", "marcus")).status).toBe(200);
    expect((await pardon("gavin", "jess", false)).status).toBe(200);

    expect(await revision()).toBe(before);
    expect((await getShares(db, BILL)).filter((s) => s.pardoned).map((s) => s.participant)).toEqual(["marcus"]);
    expect(channelPosts().map((p) => p.body.content)).toEqual([`Gavin forgave Marcus's $44.46 for ${SAIGON_KITCHEN}, so Marcus owes nothing.`]);
  });

  it("names the member and says what they owe in all after a guest's pardon", async () => {
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

    expect(channelPosts().map((p) => p.body.content)).toEqual([
      `Gavin forgave Sam's ${samOwes} for ${SAIGON_KITCHEN}, so Dani, including Sam, owes ${daniOwes}.`,
      `Gavin forgave Dani's ${daniOwes} for ${SAIGON_KITCHEN}, so Dani, including Sam, owes nothing.`,
      // Dani's own share is still forgiven, so this is not what the pair owed before.
      `Gavin took back forgiving Sam's ${samOwes} for ${SAIGON_KITCHEN}, so Dani, including Sam, owes ${samOwes}.`,
      `Gavin took back forgiving Dani's ${daniOwes} for ${SAIGON_KITCHEN}, so Dani, including Sam, owes ${together} again.`,
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

  it("asks for nothing in Pay my share once the member and their guest are both forgiven", async () => {
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
  it("shows a guest on the tile of whoever added them, and offers a guest to anyone on a draft, with nobody to pick", async () => {
    await seedSaigon(db, BILL);
    const sam = await withGuest();
    const snapshot = (await getBillSnapshot(db, BILL))!;
    const render = (viewer: string) =>
      renderPage(snapshot.bill, splitBill(snapshot.input), snapshot.input.items, snapshot.participants, viewer);

    for (const viewer of ["gavin", "marcus"]) {
      const html = render(viewer);
      expect(await select(html, `[data-person="${sam}"]`), viewer).toEqual([]);
      expect(await select(html, '[data-person="dani"] .minis .av.is-guest'), viewer).toHaveLength(1);
      expect(await select(html, "[data-people] [data-add-guest]"), viewer).toHaveLength(1);
      expect(await select(html, "select"), viewer).toEqual([]);
    }
    expect(await select(render("zoe"), "[data-add-guest]")).toEqual([]);
    const shares = splitBill(snapshot.input).shares;
    const owed = ["dani", sam].reduce((n, id) => n + shares.find((s) => s.participant === id)!.owedCents, 0);
    expect(await select(render("dani"), `[data-owed="dani"]`)).toEqual([expect.objectContaining({ text: formatCents(owed) })]);
  });

  it("hands the confirmed page what the payer's forgive and paid controls need", async () => {
    await seedSaigon(db, BILL);
    const kim = await withGuest("Kim", "gavin");
    await confirmed();
    await recordSettlement(db, BILL, "jess", 100, "jess");
    await pardon("gavin", "marcus");

    const link = `/b/${BILL}?t=${await mintToken(BILL, "gavin", KEY, Date.now())}`;
    const response = await app.fetch(new Request(`https://aazhi.test${link}`), env(), createExecutionContext());
    const html = await response.text();
    const state = JSON.parse(/<script type="application\/json" id="bill-state">([\s\S]*?)<\/script>/.exec(html)![1]!);

    expect(state.paid).toEqual(["jess"]);
    expect(state.owing.jess.paidCents).toBe(100);
    expect(state.result.shares.find((s: any) => s.participant === "marcus").pardoned).toBe(true);
    expect(state.participants.find((p: any) => p.id === kim).addedBy).toBe("gavin");
    // Kim owes the payer directly, so Kim is a debtor of their own and not on Gavin's total.
    expect(state.owing[kim].owedCents).toBe(state.result.shares.find((s: any) => s.participant === kim).owedCents);
    expect(state.owing.gavin.owedCents).toBe(state.result.shares.find((s: any) => s.participant === "gavin").owedCents);
    expect(await select(html, '[data-person="marcus"] .badge.gift')).toHaveLength(1);
    expect(await select(html, '[data-person="jess"] .stamp')).toEqual([]);
    expect(await select(html, "[data-add-guest], [data-claim]")).toEqual([]);

    const diner = await app.fetch(
      new Request(`https://aazhi.test/b/${BILL}?t=${await mintToken(BILL, "marcus", KEY, Date.now())}`),
      env(),
      createExecutionContext(),
    );
    const mine = await diner.text();
    expect((await one(mine, "[data-you]")).attrs.class).toContain("is-forgiven");
  });
});
