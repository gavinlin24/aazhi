import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { commands } from "../../src/discord/commands";
import type { Env } from "../../src/env";
import { checkMemberProof, mintViewerToken, readViewerToken } from "../../src/web/token";
import { seedOuting } from "../fixtures/outings";
import { generateKeypair, signedRequest, testEnv, type TestKeypair } from "./helpers";

const db = workerEnv.DB;
const EPHEMERAL = 1 << 6;
const GUILD = "guild-1";

let keypair: TestKeypair;
const ready = generateKeypair().then((k) => (keypair = k));

function env(): Env {
  return { ...testEnv(keypair.publicKeyHex), DISCORD_BOT_TOKEN: "bot-token", TOKEN_SIGNING_KEY: "k" };
}

let lookups: string[];
let serverReply: () => Response;

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
  lookups = [];
  serverReply = () => Response.json({ id: GUILD, name: "Friday Table" });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    lookups.push(String(input));
    return serverReply();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface UserOption {
  id: string;
  username?: string;
  nick?: string;
  bot?: boolean;
}

function profileBody(target?: UserOption, guildId = GUILD) {
  return {
    id: "i-1",
    application_id: "app-1",
    type: 2,
    token: "interaction-token",
    version: 1,
    channel_id: "chan-1",
    guild_id: guildId,
    member: { user: { id: "gavin", username: "gavin", global_name: "Gavin" }, nick: null, roles: [], permissions: "0" },
    data: {
      id: "cmd-1",
      name: "profile",
      type: 1,
      ...(target
        ? {
            options: [{ name: "user", type: 6, value: target.id }],
            resolved: {
              users: { [target.id]: { id: target.id, username: target.username ?? target.id, global_name: null, bot: target.bot } },
              members: target.nick ? { [target.id]: { nick: target.nick } } : {},
            },
          }
        : {}),
    },
  };
}

async function send(body: unknown): Promise<any> {
  await ready;
  const ctx = createExecutionContext();
  const res = await app.fetch(await signedRequest(keypair, body), env(), ctx);
  await waitOnExecutionContext(ctx);
  return res.json();
}

async function twoBills() {
  await seedOuting(db, {
    id: "b1",
    people: [["gavin", "Gavin"], ["marcus", "Marcus"]],
    items: [["Pho", 2000, ["gavin"]], ["Bun", 1500, ["marcus"]]],
  });
  await seedOuting(db, { id: "b2", people: [["gavin", "Gavin"]], alongside: ["priya", "Priya"], items: [["Pho", 1800, ["gavin"]]] });
}

describe("/profile", () => {
  it("is a guild command with one optional user option", () => {
    const profile = commands.find((c) => c.name === "profile") as any;
    expect(profile.contexts).toEqual([0]);
    expect(profile.options).toEqual([{ type: 6, name: "user", description: expect.any(String) }]);
  });

  it("answers privately with only the Open profile link", async () => {
    await twoBills();
    const reply = await send(profileBody());

    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toBeUndefined();
    expect(reply.data.components).toHaveLength(1);
    const buttons = reply.data.components[0].components;
    expect(buttons).toHaveLength(1);
    expect(buttons[0].label).toBe("Open profile");
    expect(buttons[0].url).toMatch(/\/g\/guild-1\?t=[\w-]+\.[\w-]+$/);
  });

  it("puts the viewer in the token, not the person viewed", async () => {
    await twoBills();
    const reply = await send(profileBody({ id: "marcus" }));
    const { url } = reply.data.components[0].components[0];

    expect(url).toContain("/g/guild-1/u/marcus?t=");
    const grant = await readViewerToken(new URL(url).searchParams.get("t")!, "k", Date.now());
    expect(grant).toEqual({ guildId: GUILD, viewerId: "gavin", guildName: "Friday Table" });
  });

  it("still answers when Discord will not say the server's name", async () => {
    await twoBills();
    serverReply = () => new Response("nope", { status: 500 });
    const reply = await send(profileBody());
    const { url } = reply.data.components[0].components[0];
    const grant = await readViewerToken(new URL(url).searchParams.get("t")!, "k", Date.now());
    expect(grant?.guildName).toBeNull();
  });

  it("fits Discord's 512-character button URL at the longest name", async () => {
    await twoBills();
    serverReply = () => Response.json({ name: "朋友们的周五晚餐俱乐部".repeat(9) });
    const reply = await send(profileBody({ id: "1234567890123456789" }));
    await seedOuting(db, { id: "b3", guild: "guild-2", people: [["1234567890123456789", "Theo"]], alongside: ["marcus", "Marcus"], items: [["Eggs", 900, ["1234567890123456789"]]] });
    const longest = await send(profileBody({ id: "1234567890123456789" }));
    const { url } = longest.data.components[0].components[0];
    expect(url).toContain("&m=");
    expect(url.length).toBeLessThan(512);
  });

  it("links you with no bills, and the page says so", async () => {
    const reply = await send(profileBody());
    expect(reply.data.flags).toBe(EPHEMERAL);
    const url = new URL(reply.data.components[0].components[0].url);
    const page = await (await app.request(url.pathname + url.search, {}, env())).text();
    expect(page).toContain("You have no bills yet.");
  });

  it("links someone with no bills, and the page opens for them", async () => {
    const reply = await send(profileBody({ id: "priya", nick: "Priya" }));
    const url = new URL(reply.data.components[0].components[0].url);
    const page = await app.request(url.pathname + url.search, {}, env());
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("No bills yet.");
  });

  it("takes naming someone as proof they're here, even with bills only in another server", async () => {
    await seedOuting(db, {
      id: "elsewhere",
      guild: "guild-2",
      people: [["theo", "Theo Elsewhere"]],
      alongside: ["noor", "Noor"],
      items: [["Eggs", 900, ["theo"]]],
    });
    const reply = await send(profileBody({ id: "theo", nick: "Theo" }));
    const url = new URL(reply.data.components[0].components[0].url);
    expect(await checkMemberProof(url.searchParams.get("m")!, url.searchParams.get("t")!, "theo", "k")).toBe(true);
    const page = await app.request(url.pathname + url.search, {}, env());
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Theo Elsewhere");
  });

  it("gives the plain command no proof, because it vouches for nobody", async () => {
    await twoBills();
    const reply = await send(profileBody());
    expect(new URL(reply.data.components[0].components[0].url).searchParams.has("m")).toBe(false);
  });

  it("will not open someone else from a link for the plain command", async () => {
    await seedOuting(db, { id: "elsewhere", guild: "guild-2", people: [["theo", "Theo"]], alongside: ["noor", "Noor"], items: [["Eggs", 900, ["theo"]]] });
    const token = await mintViewerToken(GUILD, "gavin", null, "k", Date.now());
    expect((await app.request(`/g/${GUILD}/u/theo?t=${token}`, {}, env())).status).toBe(403);
  });

  it("turns a bot away", async () => {
    const reply = await send(profileBody({ id: "bot-1", bot: true }));
    expect(reply.data.content).toBe("Bots can't be on a bill.");
  });

  it("treats naming yourself as the plain command", async () => {
    await twoBills();
    const reply = await send(profileBody({ id: "gavin" }));
    expect(reply.data.components[0].components[0].url).toMatch(/\/g\/guild-1\?t=/);
  });
});

describe("the old Post it here button", () => {
  it("gets an explanation", async () => {
    const tap = { id: "i-2", application_id: "app-1", type: 3, token: "t", version: 1, channel_id: "chan-1", guild_id: GUILD, data: { custom_id: "profile-post:gavin", component_type: 2 } };
    expect((await send(tap)).data).toMatchObject({ content: "That action is not supported.", flags: EPHEMERAL });
  });
});
