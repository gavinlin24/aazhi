import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import type { Env } from "../../src/env";
import { readViewerToken } from "../../src/web/token";
import { seedOuting } from "../fixtures/outings";
import { generateKeypair, signedRequest, testEnv, type TestKeypair } from "./helpers";

const db = workerEnv.DB;
const EPHEMERAL = 1 << 6;
const GUILD = "guild-1";
const member = { user: { id: "gavin", username: "gavin", global_name: "Gavin" }, nick: null, roles: [], permissions: "0" };
const envelope = { application_id: "app-1", token: "interaction-token", version: 1, channel_id: "chan-1", guild_id: GUILD, member };
const command = { ...envelope, id: "i-1", type: 2, data: { id: "cmd-1", name: "leaderboard", type: 1 } };

let keypair: TestKeypair;
const ready = generateKeypair().then((k) => (keypair = k));
const today = new Date().toISOString().slice(0, 10);

function env(): Env {
  return { ...testEnv(keypair.publicKeyHex), DISCORD_BOT_TOKEN: "bot-token", TOKEN_SIGNING_KEY: "k" };
}

async function send(body: unknown): Promise<any> {
  await ready;
  const ctx = createExecutionContext();
  const res = await app.fetch(await signedRequest(keypair, body), env(), ctx);
  await waitOnExecutionContext(ctx);
  return res.json();
}

let serverReply: () => Response;

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
  serverReply = () => Response.json({ id: GUILD, name: "Dinner Club" });
  vi.stubGlobal("fetch", async () => serverReply());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function hosted(id: string, payer: [string, string]) {
  await seedOuting(db, { id, people: [payer], alongside: ["guest", "Guest"], billDate: today, items: [["Pho", 2000, [payer[0]]]] });
}

async function threeHosts() {
  for (const n of [1, 2, 3]) await hosted(`p${n}`, ["priya", "Priya"]);
  for (const n of [1, 2, 3]) await hosted(`t${n}`, ["theo", "Theo"]);
  for (const n of [1, 2]) await hosted(`g${n}`, ["gavin", "Gavin"]);
  await hosted("m1", ["marcus", "Marcus"]);
}

describe("/leaderboard", () => {
  it("answers privately with only the leaderboard link", async () => {
    await hosted("a", ["priya", "Priya"]);
    const reply = await send(command);
    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toBeUndefined();
    expect(reply.data.components).toHaveLength(1);
    const buttons = reply.data.components[0].components;
    expect(buttons).toHaveLength(1);
    const [open] = buttons;
    expect(open.label).toBe("Open leaderboard");
    expect(open.url).toContain("/g/guild-1/boards?t=");
    const grant = await readViewerToken(new URL(open.url).searchParams.get("t")!, "k", Date.now());
    expect(grant).toEqual({ guildId: GUILD, viewerId: "gavin", guildName: "Dinner Club" });

    const page = await app.request(new URL(open.url).pathname + new URL(open.url).search, {}, env());
    expect(page.status).toBe(200);
  });

  it("still links when Discord will not say the server's name", async () => {
    serverReply = () => new Response("nope", { status: 500 });
    const reply = await send(command);
    const url = new URL(reply.data.components[0].components[0].url);
    expect((await readViewerToken(url.searchParams.get("t")!, "k", Date.now()))?.guildName).toBeNull();
  });

  it("links an empty board too, because another tab can have rows", async () => {
    const reply = await send(command);
    expect(reply.data.components[0].components.map((c: any) => c.label)).toEqual(["Open leaderboard"]);
  });

  it("fits Discord's 512-character button URL at the longest server name", async () => {
    serverReply = () => Response.json({ name: "朋友们的周五晚餐俱乐部".repeat(9) });
    const reply = await send(command);
    expect(reply.data.components[0].components[0].url.length).toBeLessThan(512);
  });

  it("is not supported outside a server", async () => {
    const reply = await send({ ...command, guild_id: undefined });
    expect(reply.data.content).toBe("That action is not supported.");
  });
});

describe("the old Post it here button", () => {
  it("gets an explanation", async () => {
    const postTap = { ...envelope, id: "i-2", type: 3, data: { custom_id: "leaderboard-post", component_type: 2 } };
    expect((await send(postTap)).data).toMatchObject({ content: "That action is not supported.", flags: EPHEMERAL });
  });
});
