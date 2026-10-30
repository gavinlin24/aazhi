import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { getVenmoHandles } from "../../src/db/handles";
import { commands } from "../../src/discord/commands";
import type { Env } from "../../src/env";
import { generateKeypair, signedRequest, testEnv, type TestKeypair } from "./helpers";

const db = workerEnv.DB;
const APP_ID = "app-1";
const TOKEN = "interaction-token";
const EPHEMERAL = 1 << 6;

let keypair: TestKeypair;
const ready = generateKeypair().then((k) => (keypair = k));

function env(): Env {
  return { ...testEnv(keypair.publicKeyHex), DISCORD_BOT_TOKEN: "bot-token", DISCORD_APPLICATION_ID: APP_ID, TOKEN_SIGNING_KEY: "k" };
}

beforeEach(async () => {
  await db.prepare("DELETE FROM payment_handles").run();
  vi.stubGlobal("fetch", async () => Response.json({ id: "follow-up-1", channel_id: "chan-1" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function run(body: unknown): Promise<any> {
  await ready;
  const ctx = createExecutionContext();
  const response = await app.fetch(await signedRequest(keypair, body), env(), ctx);
  await waitOnExecutionContext(ctx);
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

async function savedVenmo(id: string): Promise<string | undefined> {
  return (await getVenmoHandles(db, [id])).get(id);
}

// `method` is what a client still holding the old command list sends.
function paywith(handle: string, who: unknown, method?: string) {
  return {
    id: "int-2",
    application_id: APP_ID,
    type: 2,
    token: TOKEN,
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    channel: { id: "chan-1", type: 0 },
    member: who,
    data: {
      id: "cmd-1",
      name: "paywith",
      type: 1,
      options: [...(method ? [{ name: "method", type: 3, value: method }] : []), { name: "handle", type: 3, value: handle }],
    },
  };
}

describe("/paywith", () => {
  it("is registered with just a handle", () => {
    const command = commands.find((c) => c.name === "paywith") as any;

    expect(command).toBeDefined();
    expect(command.options.map((o: any) => [o.name, o.required])).toEqual([["handle", true]]);
  });

  it("saves a username, replaces it on a second run, and answers privately", async () => {
    const first = await run(paywith("@gavin-lin", GAVIN));
    await run(paywith("gavin-l2", GAVIN));

    expect(first.type).toBe(4);
    expect(first.data.flags).toBe(EPHEMERAL);
    expect(first.data.content).toContain("@gavin-lin");
    expect(await savedVenmo("gavin")).toBe("gavin-l2");
  });

  it("rejects a username that is not valid and stores nothing", async () => {
    const reply = await run(paywith("evil.example/x?txn=charge", GAVIN));

    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toMatch(/venmo/i);
    expect(await savedVenmo("gavin")).toBeUndefined();
  });

  it("still saves from a client on the old command list that picked Venmo", async () => {
    await run(paywith("gavin-lin", GAVIN, "venmo"));

    expect(await savedVenmo("gavin")).toBe("gavin-lin");
  });

  // A Discord client can still send these from the command list it cached
  // before the choices went away.
  it("turns down the apps it dropped and stores nothing", async () => {
    for (const [method, handle] of [["cashapp", "GavinL"], ["zelle", "gavin@example.com"]] as const) {
      const reply = await run(paywith(handle, GAVIN, method));

      expect(reply.data.flags).toBe(EPHEMERAL);
      expect(reply.data.content).toBe("Only Venmo works now, so I didn't save that.");
    }
    expect(await savedVenmo("gavin")).toBeUndefined();
  });

  it("ignores rows saved for the apps it dropped", async () => {
    await db
      .prepare(
        `INSERT INTO payment_handles (user_id, method, handle, updated_at) VALUES
           ('gavin', 'zelle', 'gavin@example.com', '2026-10-28'), ('gavin', 'cashapp', 'GavinL', '2026-10-28')`,
      )
      .run();

    expect(await savedVenmo("gavin")).toBeUndefined();
  });
});
