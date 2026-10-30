import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmBill, deleteBill, getBill, getShares, reopenBill } from "../../src/db/bills";
import type { Env } from "../../src/env";
import { personSummary } from "../../src/db/stats";
import app from "../../src/index";
import { mintToken } from "../../src/web/token";
import { seedOuting, type Outing } from "../fixtures/outings";
import { one, select, textOf } from "./html";

const db = workerEnv.DB;
const KEY = "receipt-once-test-signing-key";
const REFUSED = "This receipt was already split.";
const gavin: [string, string] = ["gavin", "Gavin"];
const marcus: [string, string] = ["marcus", "Marcus"];
const lines: Outing["items"] = [["Pho", 2000, ["gavin"]], ["Bun", 900, ["marcus"]]];

function env(): Env {
  return { DB: db, DISCORD_PUBLIC_KEY: "00", DISCORD_BOT_TOKEN: "bot-token", DISCORD_APPLICATION_ID: "app-1", ANTHROPIC_API_KEY: "unused", TOKEN_SIGNING_KEY: KEY };
}

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
  vi.stubGlobal("fetch", async () => Response.json({ id: "msg-2", channel_id: "chan-1" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const bill = (id: string, guild: string, receiptKey: string | undefined, draft: boolean) =>
  seedOuting(db, { id, guild, channel: `chan-${id}`, people: [gavin, marcus], items: lines, receiptKey, draft });
const confirmed = (id: string, guild = "guild-1", receiptKey: string | undefined = "same-receipt") => bill(id, guild, receiptKey, false);
const draft = (id: string, guild = "guild-1", receiptKey: string | undefined = "same-receipt") => bill(id, guild, receiptKey, true);

async function confirm(id: string): Promise<Response> {
  const { revision } = (await getBill(db, id))!;
  const token = await mintToken(id, "gavin", KEY, Date.now());
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`https://aazhi.test/b/${id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ revision }),
    }),
    env(),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function billPage(id: string): Promise<string> {
  const token = await mintToken(id, "gavin", KEY, Date.now());
  return (await app.request(`/b/${id}?t=${token}`, {}, env())).text();
}

async function expectRefused(id: string): Promise<void> {
  const response = await confirm(id);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: REFUSED });
  expect((await getBill(db, id))!.status).toBe("draft");
}

describe("a receipt is credited by one confirmed bill", () => {
  it("refuses Confirm when it's confirmed in another server", async () => {
    await draft("second", "guild-2");
    await confirmed("first", "guild-1");
    await expectRefused("second");
  });

  it("refuses Confirm when it's confirmed in the same server", async () => {
    await draft("second", "guild-1");
    await confirmed("first", "guild-1");
    await expectRefused("second");
  });

  it("saves no shares on a refused bill, and credits nobody twice", async () => {
    await draft("second", "guild-2");
    await confirmed("first", "guild-1");
    await expectRefused("second");

    expect(await getShares(db, "second")).toEqual([]);
    expect((await personSummary(db, "guild-1", "gavin"))!.outings).toBe(1);
  });

  it("blocks Confirm on the page with the same words", async () => {
    await draft("second", "guild-2");
    await confirmed("first", "guild-1");
    const html = await billPage("second");

    expect((await one(html, "[data-confirm]")).attrs).toHaveProperty("disabled");
    expect(await textOf(html, "#confirm-why")).toBe(REFUSED);
  });

  it("keeps Delete on a refused bill", async () => {
    await draft("second", "guild-2");
    await confirmed("first", "guild-1");
    expect(await select(await billPage("second"), "[data-delete-bill]")).toHaveLength(1);
  });

  it("says nothing on a bill with the receipt to itself", async () => {
    await draft("only");
    expect(await select(await billPage("only"), "#confirm-why")).toEqual([]);
    expect((await confirm("only")).status).toBe(200);
  });

  it("lets a forgotten draft sit while another bill confirms, then refuses the draft", async () => {
    await draft("forgotten", "guild-1");
    await draft("real", "guild-2");

    expect((await confirm("real")).status).toBe(200);
    await expectRefused("forgotten");
  });

  it("lets only one of two Confirms land, in the database", async () => {
    await draft("a", "guild-1");
    await draft("b", "guild-2");
    const results = await Promise.all(["a", "b"].map(async (id) => confirmBill(db, id, (await getBill(db, id))!.revision, "gavin")));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "receipt-taken" });
    const statuses = await Promise.all(["a", "b"].map(async (id) => (await getBill(db, id))!.status));
    expect(statuses.sort()).toEqual(["confirmed", "draft"]);
  });

  it("refuses at the index when the read missed the other bill, and keeps no shares", async () => {
    await draft("a", "guild-1");
    await draft("b", "guild-2");
    const revision = (await getBill(db, "b"))!.revision;
    // Hides the first bill's key from the read, the way a Confirm racing past it would.
    const realBatch = db.batch.bind(db);
    let reads = 0;
    vi.spyOn(db, "batch").mockImplementation(async (statements) => {
      const results = await realBatch(statements);
      if (reads++ === 0) await confirmBill(db, "a", (await getBill(db, "a"))!.revision, "gavin");
      return results;
    });

    const lost = await confirmBill(db, "b", revision, "gavin");
    vi.restoreAllMocks();

    expect(lost).toEqual({ ok: false, reason: "receipt-taken" });
    expect((await getBill(db, "b"))!.status).toBe("draft");
    expect(await getShares(db, "b")).toEqual([]);
  });

  it("frees the key on reopen, and checks again at reconfirm", async () => {
    await draft("second", "guild-2");
    await confirmed("first", "guild-1");
    await reopenBill(db, "first");

    expect((await confirm("second")).status).toBe(200);
    await expectRefused("first");
  });

  it("lets a reopened bill confirm again when nothing took the receipt", async () => {
    await confirmed("first");
    await reopenBill(db, "first");
    expect((await confirm("first")).status).toBe(200);
  });

  it("frees the key on delete", async () => {
    await draft("second", "guild-2");
    await confirmed("first", "guild-1");
    await deleteBill(db, "first", 0);

    expect(await select(await billPage("second"), "#confirm-why")).toEqual([]);
    expect((await confirm("second")).status).toBe(200);
  });

  it("never holds back a bill with no key", async () => {
    await db.prepare("DELETE FROM bills").run();
    await bill("a", "guild-1", undefined, false);
    await bill("b", "guild-2", undefined, false);
    await draft("c", "guild-1", undefined);

    expect((await confirm("c")).status).toBe(200);
  });
});
