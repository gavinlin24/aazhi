import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import type { Env } from "../../src/env";
import { monthName } from "../../src/format";
import { readViewerToken } from "../../src/web/token";
import { seedOuting } from "../fixtures/outings";
import { generateKeypair, signedRequest, testEnv, type TestKeypair } from "./helpers";

const db = workerEnv.DB;
const EPHEMERAL = 1 << 6;
const GUILD = "guild-1";
const member = { user: { id: "gavin", username: "gavin", global_name: "Gavin" }, nick: null, roles: [], permissions: "0" };
const envelope = { application_id: "app-1", token: "interaction-token", version: 1, channel_id: "chan-1", guild_id: GUILD, member };
const command = { ...envelope, id: "i-1", type: 2, data: { id: "cmd-1", name: "leaderboard", type: 1 } };
const postTap = { ...envelope, id: "i-2", type: 3, data: { custom_id: "leaderboard-post", component_type: 2 } };

let keypair: TestKeypair;
const ready = generateKeypair().then((k) => (keypair = k));
const today = new Date().toISOString().slice(0, 10);
const month = monthName(today.slice(0, 7));

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
  it("answers privately with the top of Hosted for the month, written as 1st and 3rd", async () => {
    await threeHosts();
    const reply = await send(command);
    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toBe(`**Dinner Club, ${month}: most hosted**\n1st Priya, 3\n1st Theo, 3\n3rd Gavin, 2`);
  });

  it("links the leaderboard with a viewer token, and offers Post it here", async () => {
    await threeHosts();
    const reply = await send(command);
    const [open, post] = reply.data.components[0].components;
    expect(open.label).toBe("Open leaderboard");
    expect(open.url).toContain("/g/guild-1/boards?t=");
    const grant = await readViewerToken(new URL(open.url).searchParams.get("t")!, "k", Date.now());
    expect(grant).toEqual({ guildId: GUILD, viewerId: "gavin", guildName: "Dinner Club" });
    expect(post).toMatchObject({ label: "Post it here", custom_id: "leaderboard-post" });

    const page = await app.request(new URL(open.url).pathname + new URL(open.url).search, {}, env());
    expect(page.status).toBe(200);
  });

  it("keeps everyone in a tie for third", async () => {
    await hosted("a", ["priya", "Priya"]);
    await hosted("a2", ["priya", "Priya"]);
    await hosted("a3", ["priya", "Priya"]);
    await hosted("b", ["theo", "Theo"]);
    await hosted("b2", ["theo", "Theo"]);
    await hosted("c", ["gavin", "Gavin"]);
    await hosted("d", ["marcus", "Marcus"]);
    const { content } = (await send(command)).data;
    expect(content.split("\n").slice(1)).toEqual(["1st Priya, 3", "2nd Theo, 2", "3rd Gavin, 1", "3rd Marcus, 1"]);
  });

  it("caps a wide tie so the message stays short", async () => {
    for (let n = 0; n < 14; n++) await hosted(`w${n}`, [`p${n}`, `Person ${n}`]);
    const { content } = (await send(command)).data;
    expect(content.split("\n")).toHaveLength(11);
  });

  it("escapes Markdown in a name and in the server's", async () => {
    serverReply = () => Response.json({ name: "*Dinner*" });
    await hosted("x", ["marcus", "m_a*rcus"]);
    const { content } = (await send(command)).data;
    expect(content).toContain("\\*Dinner\\*");
    expect(content).toContain("1st m\\_a\\*rcus, 1");
  });

  it("still answers when Discord will not say the server's name", async () => {
    await threeHosts();
    serverReply = () => new Response("nope", { status: 500 });
    const reply = await send(command);
    expect(reply.data.content.split("\n")[0]).toBe(`**This server, ${month}: most hosted**`);
    const url = new URL(reply.data.components[0].components[0].url);
    expect((await readViewerToken(url.searchParams.get("t")!, "k", Date.now()))?.guildName).toBeNull();
  });

  it("says so on an empty board, and gives only the link", async () => {
    const reply = await send(command);
    expect(reply.data.content.split("\n")[1]).toBe("Nobody is on this board yet.");
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

describe("Post it here on the leaderboard", () => {
  it("posts the same lines in public without pinging anyone", async () => {
    await threeHosts();
    const reply = await send(postTap);
    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBeUndefined();
    expect(reply.data.content).toBe((await send(command)).data.content);
    expect(reply.data.allowed_mentions).toEqual({ parse: [] });
    expect(reply.data.components).toBeUndefined();
  });

  it("works the lines out again at the tap", async () => {
    await threeHosts();
    await db.prepare("UPDATE bills SET status = 'deleted' WHERE id LIKE 'p%'").run();
    expect((await send(postTap)).data.content).toContain("1st Theo, 3\n2nd Gavin, 2\n3rd Marcus, 1");
  });

  it("answers privately when nothing is left to post", async () => {
    const reply = await send(postTap);
    expect(reply.data).toMatchObject({ content: "Nobody is on this board yet.", flags: EPHEMERAL });
  });
});
