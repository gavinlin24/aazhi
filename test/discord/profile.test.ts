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

function postBody(person: string) {
  return {
    id: "i-2",
    application_id: "app-1",
    type: 3,
    token: "interaction-token",
    version: 1,
    channel_id: "chan-1",
    guild_id: GUILD,
    member: { user: { id: "gavin", username: "gavin", global_name: "Gavin" }, nick: null, roles: [], permissions: "0" },
    data: { custom_id: `profile-post:${person}`, component_type: 2 },
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

  it("answers privately with one line, Open profile, Leaderboard and Post it here", async () => {
    await twoBills();
    const reply = await send(profileBody());

    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toBe("**Gavin**: 2 outings, $38.00 spent, hosted 2 times, 0 of 10 stamps.");
    await db.prepare("INSERT INTO stamps (guild_id, user_id, key, earned_at) VALUES ('guild-1', 'gavin', 'host', '2026-10-01')").run();
    expect((await send(profileBody())).data.content).toContain("1 of 10 stamps.");
    await db.prepare("DELETE FROM stamps").run();
    const [link, board, post] = reply.data.components[0].components;
    expect(link.label).toBe("Open profile");
    expect(link.url).toMatch(/\/g\/guild-1\?t=[\w-]+\.[\w-]+$/);
    expect(board.label).toBe("Leaderboard");
    expect(board.url).toMatch(/\/g\/guild-1\/boards\?t=[\w-]+\.[\w-]+$/);
    expect(post).toMatchObject({ label: "Post it here", custom_id: "profile-post:gavin" });
  });

  it("puts the viewer in the token, not the person viewed", async () => {
    await twoBills();
    const reply = await send(profileBody({ id: "marcus" }));
    const { url } = reply.data.components[0].components[0];

    expect(reply.data.content).toBe("**Marcus**: 1 outing, $15.00 spent, hosted 0 times, 0 of 10 stamps.");
    expect(url).toContain("/g/guild-1/u/marcus?t=");
    const grant = await readViewerToken(new URL(url).searchParams.get("t")!, "k", Date.now());
    expect(grant).toEqual({ guildId: GUILD, viewerId: "gavin", guildName: "Friday Table" });
  });

  it("uses the name from this server's bills rather than the option's or another server's", async () => {
    await twoBills();
    await seedOuting(db, { id: "b3", guild: "guild-2", people: [["marcus", "Marc the Belayer"]], alongside: ["theo", "Theo"], items: [["Eggs", 900, ["marcus"]]] });
    const reply = await send(profileBody({ id: "marcus", nick: "Some Other Nick" }));
    expect(reply.data.content).toBe("**Marcus**: 2 outings, $24.00 spent, hosted once, 0 of 10 stamps.");
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
    expect(reply.data.components).toBeUndefined();
    const { url } = longest.data.components[0].components[0];
    expect(url).toContain("&m=");
    expect(url.length).toBeLessThan(512);
  });

  it("escapes Markdown in a name", async () => {
    await seedOuting(db, { id: "b1", people: [["marcus", "m_a*rcus"]], alongside: ["gavin", "Gavin"], items: [["Pho", 2000, ["marcus"]]] });
    const reply = await send(profileBody({ id: "marcus" }));
    expect(reply.data.content).toContain("**m\\_a\\*rcus**");
  });

  it("says you have no bills, with no button", async () => {
    const reply = await send(profileBody());
    expect(reply.data).toMatchObject({ content: "You have no bills yet.", flags: EPHEMERAL });
    expect(reply.data.components).toBeUndefined();
    expect(lookups).toEqual([]);
  });

  it("says someone has no bills, with no button", async () => {
    const reply = await send(profileBody({ id: "priya", nick: "Priya" }));
    expect(reply.data.content).toBe("Priya has no bills yet.");
    expect(reply.data.components).toBeUndefined();
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
    expect(reply.data.content).toBe("**Theo Elsewhere**: 1 outing, $9.00 spent, hosted once, 0 of 10 stamps.");

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

  it("counts only drafts as no bills", async () => {
    await seedOuting(db, { id: "b1", people: [["gavin", "Gavin"]], alongside: ["priya", "Priya"], items: [["Pho", 2000, ["gavin"]]], draft: true });
    expect((await send(profileBody())).data.content).toBe("You have no bills yet.");
  });

  it("counts a bill with nobody else on it as no bills", async () => {
    await seedOuting(db, { id: "b1", older: true, people: [["gavin", "Gavin"]], items: [["Pho", 2000, ["gavin"]]] });
    expect((await send(profileBody())).data.content).toBe("You have no bills yet.");
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

describe("Post it here", () => {
  it("posts the same line in public without pinging anyone", async () => {
    await twoBills();
    const reply = await send(postBody("gavin"));
    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBeUndefined();
    expect(reply.data.content).toBe("**Gavin**: 2 outings, $38.00 spent, hosted 2 times, 0 of 10 stamps.");
    expect(reply.data.allowed_mentions).toEqual({ parse: [] });
  });

  it("works out the line again at the tap", async () => {
    await twoBills();
    await db.prepare("UPDATE bills SET status = 'deleted' WHERE id = 'b2'").run();
    expect((await send(postBody("gavin"))).data.content).toBe("**Gavin**: 1 outing, $20.00 spent, hosted once, 0 of 10 stamps.");
  });

  it("answers privately when nothing is left to post", async () => {
    const reply = await send(postBody("gavin"));
    expect(reply.data.flags).toBe(EPHEMERAL);
  });
});
