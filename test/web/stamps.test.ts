import { env as workerEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getBill } from "../../src/db/bills";
import { earnStamps, unseenStamps } from "../../src/db/stamps";
import type { Env } from "../../src/env";
import app from "../../src/index";
import { mintMemberProof, mintToken, mintViewerToken } from "../../src/web/token";
import { seedOuting } from "../fixtures/outings";
import { one, select, textOf } from "./html";

const db = workerEnv.DB;
const KEY = "stamps-test-signing-key";

function env(): Env {
  return {
    DB: db,
    DISCORD_PUBLIC_KEY: "00",
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_APPLICATION_ID: "app-1",
    ANTHROPIC_API_KEY: "unused",
    TOKEN_SIGNING_KEY: KEY,
  };
}

const viewerToken = (viewer = "gavin", guild = "guild-1", name: string | null = "Friday Table") => mintViewerToken(guild, viewer, name, KEY, Date.now());
const get = (path: string) => app.request(path, {}, env());
const html = async (path: string) => (await get(path)).text();
const post = (path: string, token: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }, env());

async function give(who: string, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    await db
      .prepare("INSERT INTO stamps (guild_id, user_id, key, earned_at, seen_at) VALUES ('guild-1', ?, ?, '2026-08-28T18:00:00.000Z', '2026-08-28T18:00:00.000Z')")
      .bind(who, key)
      .run();
  }
}

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
  await db.prepare("DELETE FROM stamps").run();
  await seedOuting(db, {
    id: "a1",
    people: [["gavin", "Gavin"], ["marcus", "Marcus <b>"]],
    items: [["Pho", 2000, ["gavin"]], ["Bun", 3000, ["marcus"]]],
  });
});

describe("the stamps card", () => {
  it("sits right under the spending, and starts empty", async () => {
    const page = await html(`/g/guild-1?t=${await viewerToken()}`);
    expect(page.indexOf('<section class="card range-card"')).toBeLessThan(page.indexOf('<a class="card stamps-card"'));
    expect(page.indexOf('<a class="card stamps-card"')).toBeLessThan(page.indexOf('<div class="tiles"'));
    expect(await textOf(page, ".stamps-card .sub")).toBe("0 of 10");
    expect(await select(page, ".stamps-grid .is-off")).toHaveLength(10);
    expect(await select(page, ".stamps-grid .is-on")).toHaveLength(0);
  });

  it("names the server the stamps are from", async () => {
    const page = await html(`/g/guild-1?t=${await viewerToken()}`);
    expect(await textOf(page, ".stamps-foot")).toBe("Friday Table. Tap to see them all.");
    const unnamed = await html(`/g/guild-1?t=${await viewerToken("gavin", "guild-1", null)}`);
    expect(await textOf(unnamed, ".stamps-foot")).toBe("This server. Tap to see them all.");
  });

  it("puts what's earned first", async () => {
    await give("gavin", "magnanimous", "regular");
    const page = await html(`/g/guild-1?t=${await viewerToken()}`);
    expect(await textOf(page, ".stamps-card .sub")).toBe("2 of 10");
    const faces = await select(page, ".stamps-grid .stamp-face");
    expect(faces.slice(0, 2).map((face) => face.attrs.class)).toEqual(["stamp-face is-on", "stamp-face is-on"]);
    expect(await textOf(page, ".stamps-grid")).toMatch(/^常宽初席/);
  });

  it("shows all ten once they're all earned", async () => {
    await give("gavin", "first-seat", "regular", "word-kept", "host", "traveler", "hundred-flavors", "sharing", "full-table", "clean-books", "magnanimous");
    const page = await html(`/g/guild-1?t=${await viewerToken()}`);
    expect(await select(page, ".stamps-grid .is-on")).toHaveLength(10);
    expect(await textOf(page, ".stamps-card .sub")).toBe("10 of 10");
  });

  it("shows a friend's own stamps, above what the two of you share", async () => {
    await give("marcus", "host");
    const page = await html(`/g/guild-1/u/marcus?t=${await viewerToken()}`);
    expect(await textOf(page, ".stamps-card .sub")).toBe("1 of 10");
    expect(page.indexOf('<a class="card stamps-card"')).toBeLessThan(page.indexOf('<section class="card pair-card"'));
    expect((await one(page, ".stamps-card")).attrs.href).toContain("/g/guild-1/u/marcus/stamps?t=");
  });

  it("is one link, and reads as a count", async () => {
    const page = await html(`/g/guild-1?t=${await viewerToken()}`);
    expect((await one(page, ".stamps-card")).attrs["aria-label"]).toBe("Stamps, 0 of 10. See them all.");
  });
});

describe("the Stamps page", () => {
  it("lists all ten with how far along you are", async () => {
    await give("gavin", "first-seat");
    const page = await html(`/g/guild-1/stamps?t=${await viewerToken()}`);
    const rows = await select(page, ".stamp-list li");
    expect(rows).toHaveLength(10);
    expect(await textOf(page, ".stamp-list li:first-child")).toMatch(/^初席First SeatEarned Aug 28Your first outing in this server\.$/);
    expect(await textOf(page, ".meta")).toBe("Friday Table · 1 of 10");
    expect(await textOf(page, "h1")).toBe("Stamps");
    expect(await textOf(page, ".tabs.nav .on")).toBe("You");
    expect(await textOf(page, ".chip-back")).toBe("Back to you");
    expect(await textOf(page, ".stamp-list")).toContain("Regular1 of 3");
    expect(await textOf(page, ".stamp-list")).toContain("Full TableBest so far: 2");
    expect(await textOf(page, ".stamp-list")).toContain("MagnanimousNot yet");
  });

  it("opens for a friend, escapes their name, and goes back to them", async () => {
    const page = await html(`/g/guild-1/u/marcus/stamps?t=${await viewerToken()}`);
    expect(page).toContain("Marcus &lt;b&gt;&#39;s stamps".replace("&#39;", "'"));
    expect(page).not.toContain("Marcus <b>");
    expect(await textOf(page, ".chip-back")).toBe("Back to Marcus &lt;b&gt;");
    expect((await one(page, ".chip-back")).attrs.href).toContain("/g/guild-1/u/marcus?t=");
    expect(await select(page, ".tabs.nav .on")).toHaveLength(0);
  });

  it("carries the proof that opened someone with no bills here", async () => {
    await seedOuting(db, { id: "z1", guild: "guild-2", channel: "chan-2", people: [["theo", "Theo"], ["ana", "Ana"]], items: [["Toast", 900, ["theo"]], ["Eggs", 900, ["ana"]]] });
    const token = await viewerToken();
    expect((await get(`/g/guild-1/u/theo/stamps?t=${token}`)).status).toBe(403);
    const proof = await mintMemberProof(token, "theo", KEY);
    const profile = await html(`/g/guild-1/u/theo?t=${token}&m=${proof}`);
    const card = (await one(profile, ".stamps-card")).attrs.href!.replaceAll("&amp;", "&");
    const response = await get(card);
    expect(response.status).toBe(200);
    const back = (await one(await response.text(), ".chip-back")).attrs.href!.replaceAll("&amp;", "&");
    expect((await get(back)).status).toBe(200);
  });

  it("refuses a stale link", async () => {
    expect((await get("/g/guild-1/stamps?t=nonsense")).status).toBe(403);
  });
});

describe("the Ceremony", () => {
  const earn = async () => earnStamps(db, (await getBill(db, "a1"))!, ["gavin"]);

  it("reaches a later profile page, then stops once seen", async () => {
    await earn();
    const token = await viewerToken();
    const data = async () => JSON.parse(await textOf(await html(`/g/guild-1?t=${token}`), "#stamps-ceremony")).unseen;
    expect((await data())[0]).toMatchObject({ key: "first-seat", name: "First Seat" });
    expect((await post("/g/guild-1/stamps/seen", token, { keys: ["first-seat"] })).status).toBe(200);
    expect(await data()).toEqual([]);
  });

  it("gives the Stamps page no link to itself", async () => {
    const page = await html(`/g/guild-1/stamps?t=${await viewerToken()}`);
    expect(JSON.parse(await textOf(page, "#stamps-ceremony")).see).toBeUndefined();
  });

  it("comes with a bill's state, and a bill's token marks it seen", async () => {
    await earn();
    const token = await mintToken("a1", "gavin", KEY, Date.now());
    const state = await (await app.request("/b/a1/state", { headers: { authorization: `Bearer ${token}` } }, env())).json<{ unseen: unknown[] }>();
    expect(state.unseen).toHaveLength(1);
    expect((await post("/b/a1/stamps/seen", token, { keys: ["first-seat"] })).status).toBe(200);
    expect(await unseenStamps(db, "guild-1", "gavin")).toEqual([]);
  });

  it("won't take a viewer token from another server, or anything that isn't a stamp", async () => {
    await earn();
    expect((await post("/g/guild-1/stamps/seen", await viewerToken("gavin", "guild-2"), { keys: ["first-seat"] })).status).toBe(403);
    const token = await mintToken("a1", "gavin", KEY, Date.now());
    expect((await post("/b/a1/stamps/seen", token, { keys: ["nope"] })).status).toBe(400);
    expect(await unseenStamps(db, "guild-1", "gavin")).toHaveLength(1);
  });

  it("can only ever mark the viewer's own", async () => {
    await earnStamps(db, (await getBill(db, "a1"))!, ["gavin", "marcus"]);
    await post("/g/guild-1/stamps/seen", await viewerToken("gavin"), { keys: ["first-seat"] });
    expect(await unseenStamps(db, "guild-1", "marcus")).toHaveLength(1);
  });

  it("sends a bill link on to the same person's Stamps page", async () => {
    const token = await mintToken("a1", "gavin", KEY, Date.now());
    const response = await get(`/b/a1/stamps?t=${token}`);
    expect(response.status).toBe(302);
    expect((await get(response.headers.get("location")!)).status).toBe(200);
  });

  it("won't trade a bad link for a good one", async () => {
    expect((await get("/b/a1/stamps?t=nonsense")).status).toBe(403);
    expect((await get(`/b/z9/stamps?t=${await mintToken("a1", "gavin", KEY, Date.now())}`)).status).toBe(403);
  });
});

describe("the stamp font", () => {
  it("is a real, cacheable file", async () => {
    const response = await get("/fonts/stamps.woff2");
    expect(response.headers.get("content-type")).toBe("font/woff2");
    expect(response.headers.get("cache-control")).toContain("max-age");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("wOF2");
  });
});
