import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { confirmBill, getBill } from "../../src/db/bills";
import { recordSettlement } from "../../src/db/settlements";
import { commands } from "../../src/discord/commands";
import type { Env } from "../../src/env";
import { seedSaigon } from "../fixtures/seed";
import { generateKeypair, signedRequest, testEnv, type TestKeypair } from "./helpers";

const db = workerEnv.DB;
const BILL = "bill-1";
const APP_ID = "app-1";
const TOKEN = "interaction-token";
const EPHEMERAL = 1 << 6;

let keypair: TestKeypair;
const ready = generateKeypair().then((k) => (keypair = k));

function env(): Env {
  return { ...testEnv(keypair.publicKeyHex), DISCORD_BOT_TOKEN: "bot-token", DISCORD_APPLICATION_ID: APP_ID, TOKEN_SIGNING_KEY: "k" };
}

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
  vi.stubGlobal("fetch", async () => Response.json({ id: "follow-up-1", channel_id: "chan-1" }));
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

async function run(body: unknown): Promise<any> {
  await ready;
  const ctx = createExecutionContext();
  const response = await app.fetch(await signedRequest(keypair, body), env(), ctx);
  await settle(waitOnExecutionContext(ctx));
  return response.json();
}

function user(id: string) {
  return { id, username: `${id}_user`, global_name: null, discriminator: "0", avatar: null };
}

function member(id: string, nick: string) {
  return { user: user(id), nick, roles: [], joined_at: "2020-01-01T00:00:00.000Z", deaf: false, mute: false, flags: 0, permissions: "0" };
}

function inGuild(who: unknown) {
  return { guild_id: "guild-1", channel_id: "chan-1", channel: { id: "chan-1", type: 0 }, member: who };
}

function ledgerCommand(where: "guild" | "dm", everywhere?: boolean, who = "gavin") {
  const place =
    where === "guild"
      ? inGuild(member(who, who))
      : { channel_id: "dm-1", channel: { id: "dm-1", type: 1 }, user: user(who) };
  return {
    id: "int-4",
    application_id: APP_ID,
    type: 2,
    token: TOKEN,
    version: 1,
    ...place,
    data: {
      id: "cmd-2",
      name: "ledger",
      type: 1,
      ...(everywhere === undefined ? {} : { options: [{ name: "everywhere", type: 5, value: everywhere }] }),
    },
  };
}

async function confirmed(billId = BILL): Promise<void> {
  const bill = (await getBill(db, billId))!;
  expect(await confirmBill(db, billId, bill.revision, "gavin")).toMatchObject({ ok: true });
}

function expectPrivate(reply: any) {
  expect(reply.type).toBe(4);
  expect(reply.data.flags).toBe(EPHEMERAL);
}

describe("/ledger", () => {
  it("is registered with an optional everywhere switch and works in DMs too", () => {
    const command = commands.find((c) => c.name === "ledger") as any;

    expect(command).toBeDefined();
    expect(command.options.map((o: any) => [o.name, o.type, o.required ?? false])).toEqual([["everywhere", 5, false]]);
    expect(command.contexts).toEqual(expect.arrayContaining([0, 1]));
  });

  async function twoServers() {
    await seedSaigon(db, BILL);
    await seedSaigon(db, "bill-2", { bill: { guildId: "guild-2", channelId: "chan-2", messageId: "msg-2" } });
    await confirmed();
    await confirmed("bill-2");
    await recordSettlement(db, BILL, "marcus", 4000, "marcus");
  }

  it("shows the payer who still owes them in this server, privately, with a total", async () => {
    await twoServers();

    const reply = await run(ledgerCommand("guild"));

    expectPrivate(reply);
    const lines = reply.data.content.split("\n");
    expect(lines[0]).toMatch(/this server/i);
    expect(lines.find((l: string) => l.includes("Marcus"))).toMatch(/\$4\.46[^\n]*1 bill\b/);
    expect(lines.find((l: string) => l.includes("Priya"))).toMatch(/\$50\.91/);
    expect(reply.data.content).not.toContain("Gavin");
    // 275.79 owed on the bill by everyone but Gavin, less Marcus's 40.00.
    expect(lines.at(-1)).toContain("Total: $235.79");
  });

  it("rolls up every server with everywhere, and outside a server", async () => {
    await twoServers();

    for (const body of [ledgerCommand("guild", true), ledgerCommand("dm")]) {
      const reply = await run(body);
      expectPrivate(reply);
      expect(reply.data.content).toMatch(/every server/i);
      expect(reply.data.content.split("\n").find((l: string) => l.includes("Marcus"))).toMatch(/\$48\.92[^\n]*2 bills/);
      expect(reply.data.content.split("\n").at(-1)).toContain("Total: $511.58");
    }
  });

  it("says nobody owes them when every share is paid", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await run(ledgerCommand("guild", false, "marcus"));

    expectPrivate(reply);
    expect(reply.data.content).toMatch(/nobody owes you/i);
    expect(reply.data.content).toContain("everywhere");
  });
});
