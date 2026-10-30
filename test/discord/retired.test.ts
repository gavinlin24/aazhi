import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { confirmBill, getBill } from "../../src/db/bills";
import { MOVED } from "../../src/discord/handlers/retired";
import type { Env } from "../../src/env";
import { seedSaigon } from "../fixtures/seed";
import { generateKeypair, signedRequest, testEnv, type TestKeypair } from "./helpers";

const db = workerEnv.DB;
const BILL = "bill-1";
const APP_ID = "app-1";
const EPHEMERAL = 1 << 6;
const MESSAGE = "https://discord.com/api/v10/channels/chan-1/messages/msg-1";

let keypair: TestKeypair;
const ready = generateKeypair().then((k) => (keypair = k));

function env(): Env {
  return { ...testEnv(keypair.publicKeyHex), DISCORD_BOT_TOKEN: "bot-token", DISCORD_APPLICATION_ID: APP_ID, TOKEN_SIGNING_KEY: "k" };
}

let edits: any[];

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
  edits = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === MESSAGE && init?.method === "PATCH") edits.push(JSON.parse(String(init.body)));
    return Response.json({ id: "msg-1", channel_id: "chan-1" });
  });
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

const MARCUS = {
  user: { id: "marcus", username: "marcus_user", global_name: null, discriminator: "0", avatar: null },
  nick: "Marcus",
  roles: [],
  joined_at: "2020-01-01T00:00:00.000Z",
  deaf: false,
  mute: false,
  flags: 0,
  permissions: "0",
};

function interaction(type: number, data: unknown) {
  return {
    id: "int-1",
    application_id: APP_ID,
    type,
    token: "interaction-token",
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    channel: { id: "chan-1", type: 0 },
    member: MARCUS,
    message: { id: "msg-1", channel_id: "chan-1" },
    data,
  };
}

function tap(customId: string) {
  return interaction(3, { custom_id: customId, component_type: 2 });
}

// Every button and form the bill message and its private prompts used to
// carry, as an old message in a channel would still send them.
const OLD = [
  `confirm:${BILL}:7`,
  `orphans:${BILL}:7`,
  `reopen:${BILL}`,
  `delete:${BILL}`,
  `delete-confirm:${BILL}:0`,
  `pay:${BILL}`,
  `math:${BILL}`,
  `notmine:${BILL}`,
  `paid:${BILL}`,
  `paidall:${BILL}:4446`,
  `paidpart:${BILL}`,
  `undo:${BILL}`,
  `undopick:${BILL}`,
];

describe("buttons that moved to the page", () => {
  it("answers every old button privately, pointing at Open the split, and changes nothing", async () => {
    await seedSaigon(db, BILL);
    expect(await confirmBill(db, BILL, (await getBill(db, BILL))!.revision, "gavin")).toMatchObject({ ok: true });
    const before = await getBill(db, BILL);

    for (const customId of OLD) {
      const reply = await run(tap(customId));
      expect(reply.type, customId).toBe(4);
      expect(reply.data.flags, customId).toBe(EPHEMERAL);
      expect(reply.data.content, customId).toBe(MOVED);
    }
    expect(await getBill(db, BILL)).toEqual(before);
  });

  it("redraws the bill message so the old buttons go away", async () => {
    await seedSaigon(db, BILL);

    await run(tap(`pay:${BILL}`));

    expect(edits).toHaveLength(1);
    expect(edits[0].components.flatMap((row: any) => row.components.map((c: any) => c.custom_id))).toEqual([
      `open:${BILL}`,
      `roster:${BILL}`,
    ]);
  });

  it("answers the old paid-amount form the same way, and a bill that is gone without redrawing anything", async () => {
    const form = interaction(5, {
      custom_id: `paidamount:${BILL}`,
      components: [{ type: 18, id: 1, component: { type: 4, id: 2, custom_id: "amount", value: "10" } }],
    });

    const reply = await run(form);

    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toBe(MOVED);
    expect(edits).toEqual([]);
  });
});
