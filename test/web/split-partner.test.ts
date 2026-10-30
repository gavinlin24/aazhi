import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBill, getShares, hasSplitPartner, reopenBill } from "../../src/db/bills";
import type { Env } from "../../src/env";
import app from "../../src/index";
import { mintToken } from "../../src/web/token";
import { seedOuting, type Outing } from "../fixtures/outings";
import { one, select, textOf } from "./html";

const db = workerEnv.DB;
const KEY = "split-partner-test-signing-key";
const gavin: [string, string] = ["gavin", "Gavin"];
const marcus: [string, string] = ["marcus", "Marcus"];
const WAITING = "Add someone to split with.";

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

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
  vi.stubGlobal("fetch", async () => Response.json({ id: "msg-2", channel_id: "chan-1" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function draft(outing: Omit<Outing, "id">): Promise<void> {
  await seedOuting(db, { ...outing, id: "b1", draft: true });
}

async function confirm(body: object = {}): Promise<Response> {
  const { revision } = (await getBill(db, "b1"))!;
  const token = await mintToken("b1", "gavin", KEY, Date.now());
  const ctx = createExecutionContext();
  const request = new Request("https://aazhi.test/b/b1/confirm", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ revision, ...body }),
  });
  const response = await app.fetch(request, env(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function billPage(): Promise<string> {
  const token = await mintToken("b1", "gavin", KEY, Date.now());
  return (await app.request(`/b/b1?t=${token}`, {}, env())).text();
}

async function expectRefused(body: object = {}): Promise<void> {
  const response = await confirm(body);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: WAITING });
  expect((await getBill(db, "b1"))!.status).toBe("draft");
  expect(await getShares(db, "b1")).toEqual([]);
}

describe("Confirm needs someone to split with", () => {
  it("refuses one person alone, and the page says so with Confirm off", async () => {
    await draft({ people: [gavin], items: [["Pho", 2000, ["gavin"]]] });
    await expectRefused();
    const html = await billPage();
    expect((await one(html, "[data-confirm]")).attrs).toHaveProperty("disabled");
    expect(await textOf(html, "#confirm-why")).toBe(WAITING);
  });

  it("refuses a bill whose only other person is a guest", async () => {
    await draft({ people: [gavin], items: [["Pho", 2000, ["gavin"]]], guest: { name: "Sam", addedBy: "gavin", item: ["Bun", 900] } });
    await expectRefused();
    expect(await textOf(await billPage(), "#confirm-why")).toBe(WAITING);
  });

  it("refuses another member with nothing on the bill", async () => {
    await draft({ people: [gavin, marcus], items: [["Pho", 2000, ["gavin"]]] });
    await expectRefused();
  });

  it("refuses a member whose lines come to $0", async () => {
    await draft({ people: [gavin, marcus], items: [["Pho", 2000, ["gavin"]], ["Water", 0, ["marcus"]]] });
    await expectRefused();
  });

  it("refuses at the server even if the page offered to split the open lines", async () => {
    await draft({ people: [gavin, marcus], items: [["Pho", 2000, ["gavin"]], ["Bun", 900, []]] });
    const response = await confirm({ splitUnclaimed: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: WAITING });
    expect((await getBill(db, "b1"))!.status).toBe("draft");
  });

  it("confirms with another member who has a share", async () => {
    await draft({ people: [gavin, marcus], items: [["Pho", 2000, ["gavin"]], ["Bun", 900, ["marcus"]]] });
    expect(await select(await billPage(), "#confirm-why")).toEqual([]);
    expect((await confirm()).status).toBe(200);
    expect((await getBill(db, "b1"))!.status).toBe("confirmed");
  });

  it("confirms with a guest alongside another member", async () => {
    await draft({
      people: [gavin, marcus],
      items: [["Pho", 2000, ["gavin"]], ["Bun", 900, ["marcus"]]],
      guest: { name: "Sam", addedBy: "gavin", item: ["Rolls", 500] },
    });
    expect((await confirm()).status).toBe(200);
  });

  it("takes a guest of someone else's the same way, so only the member's own share counts", async () => {
    await draft({
      people: [gavin, marcus],
      items: [["Pho", 2000, ["gavin"]]],
      guest: { name: "Sam", addedBy: "marcus", item: ["Rolls", 500] },
    });
    await expectRefused();
  });
});

describe("a bill confirmed before the rule", () => {
  it("stays confirmed, and its page opens as it did", async () => {
    await seedOuting(db, { id: "b1", older: true, people: [gavin], items: [["Pho", 2000, ["gavin"]]] });
    expect((await getBill(db, "b1"))!.status).toBe("confirmed");
    expect((await getShares(db, "b1")).map((s) => s.owedCents)).toEqual([2000]);
    expect(await select(await billPage(), "#confirm-why")).toEqual([]);
  });

  it("meets the rule if it is reopened and confirmed again", async () => {
    await seedOuting(db, { id: "b1", older: true, people: [gavin], items: [["Pho", 2000, ["gavin"]]] });
    await reopenBill(db, "b1");
    const response = await confirm();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: WAITING });
  });
});

describe("hasSplitPartner", () => {
  const people = [{ id: "gavin", kind: "member" as const }, { id: "marcus", kind: "member" as const }, { id: "sam", kind: "guest" as const }];
  const owes = (participant: string, owedCents: number) => ({ participant, owedCents });

  it("looks for another member with a share above zero", () => {
    expect(hasSplitPartner([owes("gavin", 500), owes("marcus", 1)], people, "gavin")).toBe(true);
    expect(hasSplitPartner([owes("gavin", 500), owes("marcus", 0)], people, "gavin")).toBe(false);
    expect(hasSplitPartner([owes("gavin", 500), owes("sam", 900)], people, "gavin")).toBe(false);
    expect(hasSplitPartner([owes("gavin", 500)], people, "gavin")).toBe(false);
  });

  it("does not count a payer's own share, whoever the payer is", () => {
    expect(hasSplitPartner([owes("gavin", 500)], people, "marcus")).toBe(true);
    expect(hasSplitPartner([owes("marcus", 500)], people, "marcus")).toBe(false);
  });
});
