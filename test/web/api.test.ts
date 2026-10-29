import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { confirmBill, getBill, getBillItems, getParticipants, reopenBill } from "../../src/db/bills";
import type { Env } from "../../src/env";
import { mintToken, TOKEN_TTL_MS } from "../../src/web/token";
import { confirmingBeforeFirstWrite } from "../fixtures/race";
import { seedSaigon } from "../fixtures/seed";

const db = workerEnv.DB;
const KEY = "api-test-signing-key";
const BILL = "bill-1";
const MESSAGE = "https://discord.com/api/v10/channels/chan-1/messages/msg-1";

const item = (id: string) => `${BILL}-${id}`;

function env(database: D1Database = db): Env {
  return {
    DB: database,
    DISCORD_PUBLIC_KEY: "00",
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_APPLICATION_ID: "app-1",
    ANTHROPIC_API_KEY: "unused",
    TOKEN_SIGNING_KEY: KEY,
  };
}

let edits: any[];

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
  edits = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === MESSAGE) edits.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "msg-1", channel_id: "chan-1" });
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

async function tokenFor(who: string, billId = BILL, nowMs = Date.now()): Promise<string> {
  return mintToken(billId, who, KEY, nowMs);
}

interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

async function send(
  method: string,
  path: string,
  options: { as?: string; authorization?: string | null; body?: unknown; raw?: string; database?: D1Database } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const authorization =
    options.authorization === undefined ? `Bearer ${await tokenFor(options.as ?? "gavin")}` : options.authorization;
  if (authorization !== null) headers.authorization = authorization;
  const body = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`https://aazhi.test${path}`, { method, headers, body }),
    env(options.database),
    ctx,
  );
  await settle(waitOnExecutionContext(ctx));
  return { status: response.status, body: await response.json(), headers: response.headers };
}

function claim(as: string, itemId: string, options: { for?: string; claimed?: boolean; database?: D1Database } = {}) {
  return send("POST", `/b/${BILL}/claim`, {
    as,
    database: options.database,
    body: { itemId: item(itemId), participantId: options.for ?? as, claimed: options.claimed ?? true },
  });
}

function editItems(as: string, body: unknown, database?: D1Database) {
  return send("POST", `/b/${BILL}/item`, { as, body, database });
}

function patch(as: string, body: unknown, database?: D1Database) {
  return send("PATCH", `/b/${BILL}`, { as, body, database });
}

async function claimedBy(itemId: string): Promise<string[]> {
  return (await getBillItems(db, BILL)).find((i) => i.id === item(itemId))!.claimedBy;
}

async function revision(): Promise<number> {
  return (await getBill(db, BILL))!.revision;
}

function shareOf(reply: Reply, who: string) {
  return reply.body.result.shares.find((s: any) => s.participant === who);
}

async function snapshot() {
  return { bill: await getBill(db, BILL), items: await getBillItems(db, BILL), people: await getParticipants(db, BILL) };
}

describe("claiming", () => {
  it("lets a participant add and remove only themselves", async () => {
    await seedSaigon(db, BILL, { unclaimed: ["tea", "water"] });

    const added = await claim("marcus", "tea");
    expect(added.status).toBe(200);
    expect(await claimedBy("tea")).toEqual(["marcus"]);

    const removed = await claim("marcus", "tea", { claimed: false });
    expect(removed.status).toBe(200);
    expect(await claimedBy("tea")).toEqual([]);

    const before = await revision();
    const editsBefore = edits.length;
    const forDani = await claim("marcus", "tea", { for: "dani" });
    expect(forDani.status).toBe(403);
    expect(forDani.body.error).toMatch(/Gavin/);
    const offDani = await claim("marcus", "noodles", { for: "dani", claimed: false });
    expect(offDani.status).toBe(403);
    expect(await claimedBy("tea")).toEqual([]);
    expect(await claimedBy("noodles")).toEqual(["dani"]);
    expect(await revision()).toBe(before);
    expect(edits).toHaveLength(editsBefore);
  });

  it("lets the payer claim on anyone's behalf", async () => {
    await seedSaigon(db, BILL, { unclaimed: ["tea", "water"] });

    expect((await claim("gavin", "tea", { for: "jess" })).status).toBe(200);
    expect((await claim("gavin", "tea", { for: "priya" })).status).toBe(200);
    expect((await claim("gavin", "noodles", { for: "dani", claimed: false })).status).toBe(200);

    expect(await claimedBy("tea")).toEqual(["jess", "priya"]);
    expect(await claimedBy("noodles")).toEqual([]);
  });

  it("keeps both claims when two people claim one item at once", async () => {
    await seedSaigon(db, BILL, { unclaimed: ["noodles"] });

    const replies = await Promise.all([claim("marcus", "noodles"), claim("dani", "noodles")]);

    expect(replies.map((r) => r.status)).toEqual([200, 200]);
    expect([...(await claimedBy("noodles"))].sort()).toEqual(["dani", "marcus"]);
  });

  it("only claims for people on the bill", async () => {
    await seedSaigon(db, BILL, { participants: ["gavin", "marcus"], unclaimed: ["tea"] });

    const forStranger = await claim("gavin", "tea", { for: "zoe" });
    expect(forStranger.status).toBe(400);

    const stranger = await claim("zoe", "tea");
    expect(stranger.status).toBe(403);
    expect(stranger.body.error).toMatch(/Open the split/);

    expect(await claimedBy("tea")).toEqual([]);
  });

  it("says when the line is no longer on the bill", async () => {
    await seedSaigon(db, BILL);
    const reply = await claim("marcus", "nothing-here");
    expect(reply.status).toBe(404);
    expect(reply.body.error).toEqual(expect.any(String));
  });
});

describe("a bill that is no longer a draft", () => {
  it("refuses any write to a confirmed bill", async () => {
    await seedSaigon(db, BILL, { unclaimed: ["tea"] });
    await db.prepare("UPDATE bills SET status = 'confirmed', confirmed_at = '2026-10-28T22:00:00Z' WHERE id = ?").bind(BILL).run();
    const before = await snapshot();

    const replies = [
      await claim("marcus", "tea"),
      await claim("gavin", "noodles", { for: "dani", claimed: false }),
      await editItems("gavin", { op: "add", label: "Che ba mau", price: "6.50" }),
      await editItems("gavin", { op: "edit", itemId: item("noodles"), price: "1.00" }),
      await editItems("gavin", { op: "delete", itemId: item("noodles") }),
      await patch("gavin", { tip: "10.00" }),
      await patch("gavin", { printedTotal: null }),
      await patch("gavin", { payer: "priya" }),
    ];

    for (const reply of replies) {
      expect(reply.status).toBe(409);
      expect(reply.body.error).toMatch(/confirmed/i);
    }
    expect(await snapshot()).toEqual(before);
    expect(edits).toEqual([]);
  });

  it("refuses a write that races the payer's Confirm, and writes nothing", async () => {
    const attempts: [string, (database: D1Database) => Promise<Reply>][] = [
      ["claim", (d) => claim("marcus", "tea", { database: d })],
      ["unclaim", (d) => claim("gavin", "noodles", { for: "dani", claimed: false, database: d })],
      ["add a line", (d) => editItems("gavin", { op: "add", label: "Che ba mau", price: "6.50" }, d)],
      ["edit a line", (d) => editItems("gavin", { op: "edit", itemId: item("noodles"), price: "1.00" }, d)],
      ["delete a line", (d) => editItems("gavin", { op: "delete", itemId: item("noodles") }, d)],
      ["tip", (d) => patch("gavin", { tip: "10.00" }, d)],
      ["tip percent", (d) => patch("gavin", { tipPercent: 20 }, d)],
      ["printed total", (d) => patch("gavin", { tax: "1.00", printedTotal: null }, d)],
      ["payer", (d) => patch("gavin", { payer: "priya" }, d)],
    ];

    for (const [what, attempt] of attempts) {
      await db.prepare("DELETE FROM bills").run();
      await seedSaigon(db, BILL, { unclaimed: ["tea"] });
      const before = await snapshot();
      const race = confirmingBeforeFirstWrite(db, BILL);

      const reply = await attempt(race.db);

      expect(race.raced(), what).toBe(true);
      expect(reply.status, what).toBe(409);
      const after = await snapshot();
      expect(after.bill!.status, what).toBe("confirmed");
      expect({ ...after, bill: { ...after.bill, status: "draft", confirmedAt: null } }, what).toEqual(before);
    }
    expect(edits).toEqual([]);
  });
});

describe("the payer correcting the bill", () => {
  it("lets the payer correct a misread price and reconcile the bill", async () => {
    await seedSaigon(db, BILL);
    await db.prepare("UPDATE bill_items SET cents = 8200 WHERE id = ?").bind(item("noodles")).run();

    const state = await send("GET", `/b/${BILL}/state`, { as: "gavin" });
    expect(state.body.reconciles).toEqual({ ok: false, discrepancyCents: 5000 });

    const fixed = await editItems("gavin", { op: "edit", itemId: item("noodles"), price: "32.00" });

    expect(fixed.status).toBe(200);
    expect(fixed.body.reconciles).toEqual({ ok: true, discrepancyCents: null });
    expect(fixed.body.items.find((i: any) => i.id === item("noodles"))).toMatchObject({
      label: "Garlic noodles",
      cents: 3200,
      claimedBy: ["dani"],
    });
    expect(shareOf(fixed, "dani").owedCents).toBe(4768);
  });

  it("renames a line without touching its price or claims", async () => {
    await seedSaigon(db, BILL);

    const reply = await editItems("gavin", { op: "edit", itemId: item("noodles"), label: "  Garlic butter noodles " });

    expect(reply.status).toBe(200);
    expect((await getBillItems(db, BILL)).find((i) => i.id === item("noodles"))).toEqual({
      id: item("noodles"),
      label: "Garlic butter noodles",
      cents: 3200,
      claimedBy: ["dani"],
    });
  });

  it("lets the payer add a missed line and delete a hallucinated one", async () => {
    await seedSaigon(db, BILL);
    await db
      .prepare("INSERT INTO bill_items (id, bill_id, label, cents, position, source, confidence) VALUES (?, ?, 'Ghost dessert', 1200, 99, 'ocr', 0.2)")
      .bind(item("ghost"), BILL)
      .run();
    await db.prepare("INSERT INTO item_claims (bill_item_id, participant_id) VALUES (?, 'theo')").bind(item("ghost")).run();

    const deleted = await editItems("gavin", { op: "delete", itemId: item("ghost") });
    expect(deleted.status).toBe(200);
    expect(deleted.body.items.map((i: any) => i.id)).not.toContain(item("ghost"));
    const orphanClaims = await db.prepare("SELECT COUNT(*) AS n FROM item_claims WHERE bill_item_id = ?").bind(item("ghost")).first<{ n: number }>();
    expect(orphanClaims!.n).toBe(0);

    const added = await editItems("gavin", { op: "add", label: "Che ba mau", price: "6.50" });
    expect(added.status).toBe(200);
    const last = added.body.items.at(-1);
    expect(last).toMatchObject({ label: "Che ba mau", cents: 650, claimedBy: [] });
    const row = await db.prepare("SELECT source, confidence FROM bill_items WHERE id = ?").bind(last.id).first();
    expect(row).toEqual({ source: "manual", confidence: null });
    expect(added.body.result.billSubtotalCents).toBe(25150 + 650);

    const comp = await editItems("gavin", { op: "add", label: "Birthday comp", price: "-6.50" });
    expect(comp.body.items.at(-1)).toMatchObject({ label: "Birthday comp", cents: -650 });
    expect(comp.body.result.billSubtotalCents).toBe(25150);
  });

  it("refuses a non-payer editing a price", async () => {
    await seedSaigon(db, BILL);
    const before = await snapshot();

    const replies = [
      await editItems("marcus", { op: "edit", itemId: item("noodles"), price: "1.00" }),
      await editItems("marcus", { op: "add", label: "Free beer", price: "0.01" }),
      await editItems("marcus", { op: "delete", itemId: item("bun") }),
      await patch("marcus", { tip: "0.00" }),
      await patch("marcus", { printedTotal: "1.00" }),
    ];

    for (const reply of replies) {
      expect(reply.status).toBe(403);
      expect(reply.body.error).toMatch(/Gavin/);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("takes prices only as plain dollar amounts", async () => {
    await seedSaigon(db, BILL);
    const before = await snapshot();

    for (const price of ["32", "32.5", "-0.50"]) {
      expect((await editItems("gavin", { op: "edit", itemId: item("noodles"), price })).status, price).toBe(200);
    }
    await editItems("gavin", { op: "edit", itemId: item("noodles"), price: "32.00" });
    const settled = await snapshot();

    for (const price of ["$32.00", "32.001", "1,032.00", "1e3", "", " 32.00", "32.00 ", 3200, null, "Infinity", "10000000.00"]) {
      const reply = await editItems("gavin", { op: "edit", itemId: item("noodles"), price });
      expect(reply.status, String(price)).toBe(400);
      expect(reply.body.error).toEqual(expect.any(String));
    }
    for (const label of ["", "   ", 7, "x".repeat(121)]) {
      expect((await editItems("gavin", { op: "add", label, price: "1.00" })).status, String(label)).toBe(400);
    }
    expect((await snapshot()).items).toEqual(settled.items);
    expect(settled.items).toEqual(before.items);
  });
});

describe("tax, tip and the printed total", () => {
  it("lets the payer enter the tip as a dollar amount", async () => {
    await seedSaigon(db, BILL, { bill: { tipCents: 0 } });

    const reply = await patch("gavin", { tip: "50.30" });

    expect(reply.status).toBe(200);
    expect((await getBill(db, BILL))!.tipCents).toBe(5030);
    expect(reply.body.tipCents).toBe(5030);
    expect(reply.body.result.distributableCents).toBe(32412);
  });

  it("converts a tip percentage against the pre-tax subtotal", async () => {
    await seedSaigon(db, BILL, { bill: { tipCents: 0 } });

    const reply = await patch("gavin", { tipPercent: 20 });

    expect(reply.status).toBe(200);
    expect((await getBill(db, BILL))!.tipCents).toBe(5030); // 20% of 25150, not of 27382
    expect(reply.body.result.distributableCents).toBe(32412);
  });

  it("takes a percentage with up to two decimals and rounds the tip to the nearest cent", async () => {
    await seedSaigon(db, BILL, { bill: { tipCents: 0 } });

    await patch("gavin", { tipPercent: "18.5" }); // 4652.75 cents
    expect((await getBill(db, BILL))!.tipCents).toBe(4653);
    await patch("gavin", { tipPercent: 18.25 }); // 4589.875 cents
    expect((await getBill(db, BILL))!.tipCents).toBe(4590);
    await patch("gavin", { tipPercent: "0" });
    expect((await getBill(db, BILL))!.tipCents).toBe(0);

    for (const tipPercent of ["18.123", 18.123, -5, "-5", "abc", "", "1e1", null, true, 100.01]) {
      const reply = await patch("gavin", { tipPercent });
      expect(reply.status, String(tipPercent)).toBe(400);
    }
    expect((await getBill(db, BILL))!.tipCents).toBe(0);
  });

  it("takes the tip as dollars or as a percentage, never both", async () => {
    await seedSaigon(db, BILL);
    const before = await revision();

    const reply = await patch("gavin", { tip: "10.00", tipPercent: 20 });

    expect(reply.status).toBe(400);
    expect(reply.body.error).toMatch(/tip/i);
    expect(await revision()).toBe(before);
  });

  it("lets the payer set the tax", async () => {
    await seedSaigon(db, BILL);

    const reply = await patch("gavin", { tax: "22.00" });

    expect(reply.body.taxCents).toBe(2200);
    expect(reply.body.reconciles).toEqual({ ok: false, discrepancyCents: -32 });
    for (const tax of ["-1.00", 22, null]) {
      expect((await patch("gavin", { tax })).status, String(tax)).toBe(400);
    }
    expect((await getBill(db, BILL))!.taxCents).toBe(2200);
  });

  it("lets the payer enter a printed total the model could not read, and clear it again", async () => {
    await seedSaigon(db, BILL, { bill: { printedTotalCents: null } });

    const unread = await send("GET", `/b/${BILL}/state`, { as: "gavin" });
    expect(unread.body.printedTotalCents).toBeNull();
    expect(unread.body.reconciles).toEqual({ ok: false, discrepancyCents: null });

    const entered = await patch("gavin", { printedTotal: "273.82" });
    expect(entered.status).toBe(200);
    expect(entered.body.printedTotalCents).toBe(27382);
    expect(entered.body.reconciles).toEqual({ ok: true, discrepancyCents: null });
    expect((await getBill(db, BILL))!.printedTotalCents).toBe(27382);

    const wrong = await patch("gavin", { printedTotal: "270.00" });
    expect(wrong.body.reconciles).toEqual({ ok: false, discrepancyCents: 382 });

    const cleared = await patch("gavin", { printedTotal: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.printedTotalCents).toBeNull();
    expect((await getBill(db, BILL))!.printedTotalCents).toBeNull();
  });
});

describe("who paid", () => {
  it("lets the payer hand the bill to whoever's card actually went down", async () => {
    await seedSaigon(db, BILL);

    const reply = await patch("gavin", { payer: "priya" });

    expect(reply.status).toBe(200);
    expect(reply.body.payerId).toBe("priya");
    expect(reply.body.viewerIsPayer).toBe(false);
    expect(reply.body.editable).toBe("self");
    expect(reply.body.result.payerCollectsCents).toBe(32412 - 5091);
    expect((await getBill(db, BILL))!.payerId).toBe("priya");
    expect(edits).toHaveLength(1);
    expect(JSON.stringify(edits[0].embeds)).toMatch(/Priya \$50\.91 \(paid the bill\)/);

    // The new payer now holds the payer's controls, and the old one does not.
    expect((await patch("gavin", { payer: "gavin" })).status).toBe(403);
    expect((await patch("priya", { payer: "gavin" })).status).toBe(200);
  });

  it("is for the payer only", async () => {
    await seedSaigon(db, BILL);
    const before = await snapshot();

    const reply = await patch("marcus", { payer: "marcus" });

    expect(reply.status).toBe(403);
    expect(reply.body.error).toMatch(/Gavin/);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses someone who is not on the roster, or a guest", async () => {
    await seedSaigon(db, BILL, { participants: ["gavin", "marcus", "dani"] });
    await db
      .prepare("INSERT INTO participants (bill_id, id, kind, display_name, added_by) VALUES (?, 'guest-sam', 'guest', 'Sam', 'dani')")
      .bind(BILL)
      .run();
    const before = await snapshot();

    for (const payer of ["priya", "zoe", "guest-sam"]) {
      const reply = await patch("gavin", { payer });
      expect(reply.status, payer).toBe(400);
      expect(reply.body.error, payer).toEqual(expect.any(String));
    }
    expect(await snapshot()).toEqual(before);
  });

  it("refuses once anyone has paid on a reopened bill, so no payment is redirected", async () => {
    await seedSaigon(db, BILL);
    expect(await confirmBill(db, BILL, await revision(), "gavin")).toMatchObject({ ok: true });
    await db
      .prepare(
        "INSERT INTO settlements (id, bill_id, participant_id, cents, recorded_at, recorded_by) VALUES ('s-1', ?, 'marcus', 4446, '2026-10-29T09:00:00.000Z', 'marcus')",
      )
      .bind(BILL)
      .run();
    await reopenBill(db, BILL);
    const before = await snapshot();

    const reply = await patch("gavin", { payer: "priya" });

    expect(reply.status).toBe(409);
    expect(reply.body.error).toMatch(/already (been )?paid/i);
    expect(reply.body.error).toMatch(/Gavin/);
    expect(await snapshot()).toEqual(before);
    expect(edits).toHaveLength(0);
  });
});

describe("what every response carries", () => {
  it("returns the recomputed shares with every write", async () => {
    await seedSaigon(db, BILL, { unclaimed: ["tea", "water"] });
    const before = await revision();

    const reply = await claim("marcus", "tea");

    expect(reply.status).toBe(200);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(reply.body).toMatchObject({
      billId: BILL,
      revision: before + 1,
      status: "draft",
      payerId: "gavin",
      viewer: "marcus",
      viewerIsPayer: false,
      editable: "self",
      taxCents: 2232,
      tipCents: 5030,
      printedTotalCents: 27382,
      reconciles: { ok: true, discrepancyCents: null },
    });
    expect(reply.body.items.find((i: any) => i.id === item("tea")).claimedBy).toEqual(["marcus"]);
    expect(reply.body.participants.map((p: any) => p.id)).toEqual(["dani", "gavin", "jess", "lena", "marcus", "omar", "priya", "theo"]);
    // Marcus alone on the tea: 2450 + 500 + 1500 food, prorated over the whole bill.
    expect(shareOf(reply, "marcus")).toMatchObject({ subtotalCents: 4450 });
    expect(reply.body.result.distributableCents).toBe(32412);
    expect(reply.body.result.unclaimedCents).toBe(32412 - reply.body.result.shares.reduce((t: number, s: any) => t + s.owedCents, 0));

    // The channel message follows, through the coalesced edit.
    expect(edits).toHaveLength(1);
    expect(JSON.stringify(edits[0].embeds)).toContain("Thai iced tea x3 · $15.00 · Marcus");
  });

  it("serves the same state to a poll without writing anything", async () => {
    await seedSaigon(db, BILL, { unclaimed: ["tea"] });
    const before = await revision();

    const reply = await send("GET", `/b/${BILL}/state`, { as: "marcus" });

    expect(reply.status).toBe(200);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(reply.body).toMatchObject({ revision: before, status: "draft", viewer: "marcus", viewerIsPayer: false, editable: "self" });
    expect(reply.body.result.unclaimedCents).toBeGreaterThan(0);
    expect(await revision()).toBe(before);
    expect(edits).toEqual([]);

    const payer = await send("GET", `/b/${BILL}/state`, { as: "gavin" });
    expect(payer.body).toMatchObject({ viewerIsPayer: true, editable: "all" });
  });

  it("tells a poll when the bill was confirmed, replaced or never existed", async () => {
    await seedSaigon(db, BILL);
    await db.prepare("UPDATE bills SET status = 'confirmed' WHERE id = ?").bind(BILL).run();
    const confirmed = await send("GET", `/b/${BILL}/state`, { as: "marcus" });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ status: "confirmed", editable: "none" });

    await db.prepare("UPDATE bills SET status = 'superseded' WHERE id = ?").bind(BILL).run();
    const replaced = await send("GET", `/b/${BILL}/state`, { as: "marcus" });
    expect(replaced.status).toBe(410);
    expect(replaced.body.error).toMatch(/replaced/i);
    expect(replaced.body).not.toHaveProperty("items");

    const missing = await send("GET", `/b/nope/state`, { authorization: `Bearer ${await tokenFor("marcus", "nope")}` });
    expect(missing.status).toBe(404);
  });
});

describe("the bearer token", () => {
  it("refuses a missing, malformed, expired or borrowed token, and says to tap the button again", async () => {
    await seedSaigon(db, BILL, { unclaimed: ["tea"] });
    await seedSaigon(db, "bill-2", { bill: { channelId: "chan-2" } });
    const valid = await tokenFor("gavin");
    const expired = await tokenFor("gavin", BILL, Date.now() - TOKEN_TTL_MS - 1);
    const borrowed = await tokenFor("gavin", "bill-2");
    const before = await snapshot();

    const authorizations = [
      null,
      "",
      "Bearer",
      "Bearer ",
      `Basic ${valid}`,
      `bearer${valid}`,
      `Bearer ${valid}x`,
      `Bearer ${expired}`,
      `Bearer ${borrowed}`,
      "Bearer garbage",
    ];
    for (const authorization of authorizations) {
      const replies = [
        await send("GET", `/b/${BILL}/state`, { authorization }),
        await send("POST", `/b/${BILL}/claim`, { authorization, body: { itemId: item("tea"), participantId: "gavin", claimed: true } }),
        await send("POST", `/b/${BILL}/item`, { authorization, body: { op: "delete", itemId: item("tea") } }),
        await send("PATCH", `/b/${BILL}`, { authorization, body: { tip: "0.00" } }),
      ];
      for (const reply of replies) {
        expect(reply.status, String(authorization)).toBe(403);
        expect(reply.body.error).toMatch(/Open the split/);
        expect(JSON.stringify(reply.body)).not.toContain("Saigon");
      }
    }
    expect(await snapshot()).toEqual(before);
    expect(edits).toEqual([]);
  });

  it("does not take the token from the query string", async () => {
    await seedSaigon(db, BILL);
    const reply = await send("GET", `/b/${BILL}/state?t=${await tokenFor("gavin")}`, { authorization: null });
    expect(reply.status).toBe(403);
  });
});

describe("request bodies", () => {
  it("refuses anything but the exact shapes, without writing", async () => {
    await seedSaigon(db, BILL, { unclaimed: ["tea"] });
    const before = await snapshot();

    const bad: [string, string, unknown][] = [
      ["POST", "claim", "not json"],
      ["POST", "claim", []],
      ["POST", "claim", { itemId: item("tea"), participantId: "gavin" }],
      ["POST", "claim", { itemId: item("tea"), participantId: "gavin", claimed: "yes" }],
      ["POST", "claim", { itemId: item("tea"), participantId: 7, claimed: true }],
      ["POST", "claim", { itemId: item("tea"), participantId: "gavin", claimed: true, extra: 1 }],
      ["POST", "item", { op: "rename", itemId: item("tea") }],
      ["POST", "item", { op: "add", label: "Che" }],
      ["POST", "item", { op: "add", label: "Che", price: "1.00", itemId: item("tea") }],
      ["POST", "item", { op: "edit", itemId: item("tea") }],
      ["POST", "item", { op: "delete" }],
      ["POST", "item", { op: "delete", itemId: item("tea"), price: "1.00" }],
      ["PATCH", "", {}],
      ["PATCH", "", { tax: "1.00", service: "2.00" }],
      ["PATCH", "", { printedTotal: 27382 }],
      ["PATCH", "", { tip: null }],
      ["PATCH", "", null],
      ["PATCH", "", { payer: "" }],
      ["PATCH", "", { payer: 7 }],
      ["PATCH", "", { payer: "priya", tip: "1.00" }],
    ];
    for (const [method, path, body] of bad) {
      const reply = await send(method, path ? `/b/${BILL}/${path}` : `/b/${BILL}`, {
        as: "gavin",
        ...(typeof body === "string" ? { raw: body } : { body }),
      });
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(reply.body.error).toEqual(expect.any(String));
    }
    expect(await snapshot()).toEqual(before);
  });
});
