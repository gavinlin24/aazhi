import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { getBill, getParticipants } from "../../src/db/bills";
import type { Env } from "../../src/env";
import { readToken } from "../../src/web/token";
import { confirmingBeforeFirstWrite } from "../fixtures/race";
import { seedSaigon } from "../fixtures/seed";
import { one } from "../web/html";
import { generateKeypair, signedRequest, testEnv, type TestKeypair } from "./helpers";

const db = workerEnv.DB;
const API = "https://discord.com/api/v10";
const KEY = "roster-test-signing-key";
const EPHEMERAL = 1 << 6;

let keypair: TestKeypair;
const ready = generateKeypair().then((k) => (keypair = k));

function env(): Env {
  return { ...testEnv(keypair.publicKeyHex), DISCORD_BOT_TOKEN: "bot-token", TOKEN_SIGNING_KEY: KEY };
}

let calls: { url: string; method: string; body: any }[];

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
  calls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const channel = /\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(url);
    return Response.json(channel ? { id: channel[2], channel_id: channel[1] } : {});
  });
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

async function run(body: unknown): Promise<any> {
  await ready;
  const ctx = createExecutionContext();
  const response = await app.fetch(await signedRequest(keypair, body), env(), ctx);
  await settle(waitOnExecutionContext(ctx));
  return response.json();
}

function messageEdits() {
  return calls.filter((c) => c.url === `${API}/channels/chan-1/messages/msg-1`);
}

function member(id: string, names: { nick?: string | null; global_name?: string | null; username?: string } = {}) {
  return {
    user: {
      id,
      username: names.username ?? `${id}_user`,
      global_name: names.global_name === undefined ? null : names.global_name,
      discriminator: "0",
      avatar: null,
    },
    nick: names.nick ?? null,
    roles: [],
    joined_at: "2020-01-01T00:00:00.000Z",
    deaf: false,
    mute: false,
    flags: 0,
    permissions: "0",
  };
}

function component(data: Record<string, unknown>, who: unknown) {
  return {
    id: "int-9",
    application_id: "app-1",
    type: 3,
    token: "interaction-token",
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    channel: { id: "chan-1", type: 0 },
    member: who,
    message: { id: "msg-1", channel_id: "chan-1" },
    data,
  };
}

function tapOpen(billId: string, who: unknown) {
  return component({ custom_id: `open:${billId}`, component_type: 2 }, who);
}

function linkButton(reply: any): { style: number; label: string; url: string } {
  expect(reply.data.components).toHaveLength(1);
  const [button] = reply.data.components[0].components;
  return button;
}

describe("Open the split", () => {
  it("adds the tapping user to the roster", async () => {
    await seedSaigon(db, "bill-1", { participants: ["gavin"] });
    const before = (await getBill(db, "bill-1"))!.revision;

    const reply = await run(tapOpen("bill-1", member("marcus", { nick: "Marcus", global_name: "Marcus G" })));

    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBe(EPHEMERAL);
    const roster = await getParticipants(db, "bill-1");
    expect(roster.map((p) => [p.id, p.kind, p.displayName])).toEqual([
      ["gavin", "member", "Gavin"],
      ["marcus", "member", "Marcus"],
    ]);
    expect((await getBill(db, "bill-1"))!.revision).toBeGreaterThan(before);

    // The channel message picks up the new name, through the coalesced edit.
    expect(messageEdits()).toHaveLength(1);
    expect(JSON.stringify(messageEdits()[0]!.body.embeds)).toContain("Marcus");
  });

  it("names a new diner by global name, then username, when they have no nickname", async () => {
    await seedSaigon(db, "bill-1", { participants: ["gavin"] });

    await run(tapOpen("bill-1", member("dani", { global_name: "Dani R" })));
    await run(tapOpen("bill-1", member("omar", { username: "omar_k" })));

    const names = (await getParticipants(db, "bill-1")).map((p) => p.displayName);
    expect(names).toEqual(["Gavin", "Dani R", "omar_k"]);
  });

  it("replies with a private link that opens the page as that person", async () => {
    await seedSaigon(db, "bill-1", { unclaimed: ["tea", "water"] });

    const reply = await run(tapOpen("bill-1", member("marcus", { nick: "Marcus" })));

    const button = linkButton(reply);
    expect(button.style).toBe(5);
    expect(button.label).toMatch(/open/i);
    const url = new URL(button.url);
    expect(url.origin).toBe("https://aazhi.test");
    expect(url.pathname).toBe("/b/bill-1");
    expect(await readToken(url.searchParams.get("t")!, KEY, Date.now())).toEqual({
      billId: "bill-1",
      participantId: "marcus",
    });
    expect(reply.data.content).toMatch(/30 minutes/);

    const page = await app.fetch(new Request(button.url), env(), createExecutionContext());
    expect(page.status).toBe(200);
    const html = await page.text();
    expect((await one(html, "#bill")).attrs["data-viewer"]).toBe("marcus");
    expect((await one(html, "[data-you-owed]")).text).toBe("$38.02");
  });

  it("leaves the roster and the message alone for someone already on it", async () => {
    await seedSaigon(db, "bill-1");
    const before = (await getBill(db, "bill-1"))!.revision;

    const reply = await run(tapOpen("bill-1", member("marcus", { nick: "Marcus" })));

    expect(linkButton(reply).url).toContain("/b/bill-1?t=");
    expect((await getBill(db, "bill-1"))!.revision).toBe(before);
    expect(calls).toEqual([]);
  });

  it("gives a link but does not join someone to a bill that is already confirmed", async () => {
    await seedSaigon(db, "bill-1", { participants: ["gavin"] });
    await db.prepare("UPDATE bills SET status = 'confirmed', confirmed_at = '2026-10-28T22:00:00Z' WHERE id = 'bill-1'").run();

    const reply = await run(tapOpen("bill-1", member("marcus", { nick: "Marcus" })));

    expect(linkButton(reply).url).toContain("/b/bill-1?t=");
    expect((await getParticipants(db, "bill-1")).map((p) => p.id)).toEqual(["gavin"]);
    expect(calls).toEqual([]);
  });

  it("does not join someone to a bill confirmed between the check and the insert", async () => {
    await seedSaigon(db, "bill-1", { participants: ["gavin"] });
    const race = confirmingBeforeFirstWrite(db, "bill-1");
    await ready;

    const ctx = createExecutionContext();
    const response = await app.fetch(
      await signedRequest(keypair, tapOpen("bill-1", member("marcus", { nick: "Marcus" }))),
      { ...env(), DB: race.db },
      ctx,
    );
    await settle(waitOnExecutionContext(ctx));
    const reply: any = await response.json();

    expect(race.raced()).toBe(true);
    expect(linkButton(reply).url).toContain("/b/bill-1?t=");
    expect((await getParticipants(db, "bill-1")).map((p) => p.id)).toEqual(["gavin"]);
    expect(calls).toEqual([]);
  });

  it("says a superseded split was replaced, with no link and no roster change", async () => {
    await seedSaigon(db, "bill-1", { participants: ["gavin"] });
    await db.prepare("UPDATE bills SET status = 'superseded' WHERE id = 'bill-1'").run();

    const reply = await run(tapOpen("bill-1", member("marcus", { nick: "Marcus" })));

    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toMatch(/replaced/i);
    expect(reply.data.components ?? []).toEqual([]);
    expect((await getParticipants(db, "bill-1")).map((p) => p.id)).toEqual(["gavin"]);
  });

  it("says so when the bill no longer exists", async () => {
    const reply = await run(tapOpen("gone", member("marcus")));

    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toMatch(/can't find/i);
    expect(reply.data.components ?? []).toEqual([]);
  });
});

function pick(billId: string, who: unknown, picked: { id: string; nick?: string | null; global_name?: string | null; bot?: boolean }[]) {
  return component(
    {
      custom_id: `roster:${billId}`,
      component_type: 5,
      values: picked.map((p) => p.id),
      resolved: {
        users: Object.fromEntries(
          picked.map((p) => [
            p.id,
            {
              id: p.id,
              username: `${p.id}_user`,
              global_name: p.global_name ?? null,
              discriminator: "0",
              avatar: null,
              ...(p.bot ? { bot: true } : {}),
            },
          ]),
        ),
        members: Object.fromEntries(
          picked.map((p) => [p.id, { nick: p.nick ?? null, roles: [], joined_at: "2020-01-01T00:00:00.000Z", flags: 0, permissions: "0" }]),
        ),
      },
    },
    who,
  );
}

describe("the payer's roster picker", () => {
  it("is for the payer only", async () => {
    await seedSaigon(db, "bill-1", { participants: ["gavin", "marcus"] });
    const before = (await getBill(db, "bill-1"))!.revision;

    const reply = await run(pick("bill-1", member("marcus", { nick: "Marcus" }), [{ id: "dani", nick: "Dani" }]));

    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toMatch(/only Gavin/i);
    expect(reply.data.content).toMatch(/Open the split/);
    expect((await getParticipants(db, "bill-1")).map((p) => p.id)).toEqual(["gavin", "marcus"]);
    expect((await getBill(db, "bill-1"))!.revision).toBe(before);
    expect(calls).toEqual([]);
  });

  it("adds the picked members, skipping bots and anyone already on the bill", async () => {
    await seedSaigon(db, "bill-1", { participants: ["gavin", "jess"] });

    const reply = await run(
      pick("bill-1", member("gavin", { nick: "Gavin" }), [
        { id: "dani", nick: "Dani" },
        { id: "aazhi-bot", bot: true },
        { id: "jess", nick: "Jessica" },
        { id: "marcus", global_name: "Marcus G" },
        { id: "omar" },
      ]),
    );

    const roster = await getParticipants(db, "bill-1");
    expect(roster.map((p) => [p.id, p.kind, p.displayName])).toEqual([
      ["gavin", "member", "Gavin"],
      ["jess", "member", "Jess"],
      ["dani", "member", "Dani"],
      ["marcus", "member", "Marcus G"],
      ["omar", "member", "omar_user"],
    ]);
    expect(reply.data.flags).toBe(EPHEMERAL);
    // Escaped for Discord markdown, so the underscore shows as typed.
    expect(reply.data.content).toContain("Added Dani, Marcus G and omar\\_user");
    expect(reply.data.content).not.toMatch(/Jess/);
    expect(messageEdits()).toHaveLength(1);
  });

  it("says nobody new was added when everyone picked is already on the bill", async () => {
    await seedSaigon(db, "bill-1", { participants: ["gavin", "jess"] });

    const reply = await run(pick("bill-1", member("gavin", { nick: "Gavin" }), [{ id: "jess", nick: "Jess" }]));

    expect(reply.data.content).toMatch(/already on/i);
    expect(calls).toEqual([]);
  });

  it("adds nobody to a bill confirmed between the check and the insert", async () => {
    await seedSaigon(db, "bill-1", { participants: ["gavin"] });
    const before = (await getBill(db, "bill-1"))!.revision;
    const race = confirmingBeforeFirstWrite(db, "bill-1");
    await ready;

    const ctx = createExecutionContext();
    const response = await app.fetch(
      await signedRequest(keypair, pick("bill-1", member("gavin", { nick: "Gavin" }), [{ id: "dani", nick: "Dani" }])),
      { ...env(), DB: race.db },
      ctx,
    );
    await settle(waitOnExecutionContext(ctx));
    const reply: any = await response.json();

    expect(race.raced()).toBe(true);
    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toMatch(/confirmed/i);
    expect((await getParticipants(db, "bill-1")).map((p) => p.id)).toEqual(["gavin"]);
    expect((await getBill(db, "bill-1"))!.revision).toBe(before);
    expect(calls).toEqual([]);
  });

  it("refuses to change the roster of a split that was replaced", async () => {
    await seedSaigon(db, "bill-1", { participants: ["gavin"] });
    await db.prepare("UPDATE bills SET status = 'superseded' WHERE id = 'bill-1'").run();

    const reply = await run(pick("bill-1", member("gavin", { nick: "Gavin" }), [{ id: "dani", nick: "Dani" }]));

    expect(reply.data.content).toMatch(/replaced/i);
    expect((await getParticipants(db, "bill-1")).map((p) => p.id)).toEqual(["gavin"]);
  });
});
