import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBill, getBillItems, getShares } from "../../src/db/bills";
import { personProfile, personSummary, serverBoards } from "../../src/db/stats";
import type { Env } from "../../src/env";
import { EXTRACT_TOOL_NAME } from "../../src/extract/schema";
import app from "../../src/index";
import { mintToken, mintViewerToken } from "../../src/web/token";
import { generateKeypair, signedRequest, testEnv, type TestKeypair } from "./helpers";

const db = workerEnv.DB;
const API = "https://discord.com/api/v10";
const APP_ID = "app-1";
const RECEIPT_URL = "https://cdn.discordapp.com/attachments/1/2/receipt.jpg";
const EPHEMERAL = 1 << 6;
const SUPPRESS_EMBEDS = 1 << 2;
// 7:30pm in Los Angeles on the day of the receipt below.
const NOW = Date.parse("2026-10-30T02:30:00Z");
const VIEW_SEND = (1n << 10n) | (1n << 11n);

const LUNCH = {
  is_receipt: true,
  readable: true,
  place: "Saigon Kitchen",
  bill_date: "2026-10-29",
  printed_time: "6:12 PM",
  items: [
    { label: "Pho", price: "18.00", confidence: 0.95 },
    { label: "Spring rolls", price: "9.00", confidence: 0.95 },
  ],
  discount: null,
  tax: "3.00",
  printed_total: "30.00",
};

let keypair: TestKeypair;
const ready = generateKeypair().then((k) => (keypair = k));

function env(): Env {
  return { ...testEnv(keypair?.publicKeyHex ?? "00"), DISCORD_BOT_TOKEN: "bot-token", DISCORD_APPLICATION_ID: APP_ID, ANTHROPIC_API_KEY: "anthropic-key" };
}

interface Call {
  url: string;
  method: string;
  body: any;
}

let calls: Call[];
let read: unknown;
let check: () => Response;
let channelFailures: number;

const answer = (fields: Record<string, unknown>) => Response.json({ content: [{ type: "text", text: JSON.stringify(fields) }] });
const REAL = { medium: "photo_of_paper", edited: false, till_printed: true };
const FAKE = { ...REAL, edited: true };

beforeEach(async () => {
  await ready;
  await db.prepare("DELETE FROM bills").run();
  await db.prepare("DELETE FROM receipt_reads").run();
  await db.prepare("DELETE FROM stamps").run();
  calls = [];
  read = LUNCH;
  check = () => answer(REAL);
  channelFailures = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith("https://api.anthropic.com")) {
      const sent = JSON.parse(String(init!.body));
      if (sent.output_config) return check();
      return Response.json({ content: [{ type: "tool_use", id: "t", name: EXTRACT_TOOL_NAME, input: read }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } });
    }
    if (url.includes("/channels/") && channelFailures > 0) {
      channelFailures--;
      return new Response("upstream sad", { status: 500 });
    }
    return Response.json({ id: "msg-post", channel_id: "chan-1" });
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const member = (id: string) => ({
  user: { id, username: id, global_name: id, discriminator: "0", avatar: null },
  roles: [],
  joined_at: "2020-01-01T00:00:00.000Z",
  deaf: false,
  mute: false,
  flags: 0,
  permissions: "0",
});

function slashLog(id = "gavin", overrides: Record<string, unknown> = {}) {
  return {
    id: "int-1",
    application_id: APP_ID,
    type: 2,
    token: "tok",
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    channel: { id: "chan-1", type: 0 },
    app_permissions: String(VIEW_SEND),
    member: member(id),
    data: {
      id: "cmd-1",
      name: "log",
      type: 1,
      options: [{ name: "receipt", type: 11, value: "att-0" }],
      resolved: { attachments: { "att-0": { id: "att-0", filename: "r.jpg", size: 1, url: RECEIPT_URL, proxy_url: RECEIPT_URL, content_type: "image/jpeg" } } },
    },
    ...overrides,
  };
}

async function run(body: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(await signedRequest(keypair, body), env(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function web(path: string, token: string, method = "GET", body?: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  const init: RequestInit = { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await app.fetch(new Request(`https://aazhi.test${path}`, init), env(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const replies = () => calls.filter((c) => c.url.includes("/webhooks/"));
const lastReply = () => replies().at(-1)!.body;
const posts = () => calls.filter((c) => c.method === "POST" && /\/channels\/[^/]+\/messages$/.test(c.url));
const billCount = async () => (await db.prepare("SELECT COUNT(*) AS n FROM bills").first<{ n: number }>())!.n;

interface Draft {
  id: string;
  token: string;
  path: string;
}

async function startLog(who = "gavin"): Promise<Draft> {
  await run(slashLog(who));
  const url = new URL(lastReply().components[0].components[0].url);
  const id = url.pathname.split("/").pop()!;
  return { id, token: url.searchParams.get("t")!, path: `/b/${id}` };
}

async function pick(d: Draft, who = "gavin", lines = 1): Promise<void> {
  const items = await getBillItems(db, d.id);
  for (const item of items.slice(0, lines)) {
    expect((await web(`${d.path}/claim`, d.token, "POST", { itemId: item.id, participantId: who, claimed: true })).status).toBe(200);
  }
}

async function logIt(d: Draft): Promise<Response> {
  const { revision } = (await getBill(db, d.id))!;
  return web(`${d.path}/confirm`, d.token, "POST", { revision });
}

async function logged(who = "gavin"): Promise<Draft> {
  const d = await startLog(who);
  await pick(d, who);
  expect((await logIt(d)).status).toBe(200);
  return d;
}

function press(side: "real" | "fake", id: string, who: string) {
  return run({
    id: "int-9",
    application_id: APP_ID,
    type: 3,
    token: "tok-vote",
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    member: member(who),
    message: { id: "msg-post" },
    data: { custom_id: `logvote:${side}:${id}`, component_type: 2 },
  });
}

async function receiptKey(): Promise<string> {
  const d = await startLog("keymaker");
  const { receipt_key: key } = (await db.prepare("SELECT receipt_key FROM bills WHERE id = ?").bind(d.id).first<{ receipt_key: string }>())!;
  await db.prepare("DELETE FROM bills WHERE id = ?").bind(d.id).run();
  calls = [];
  return key;
}

// A row as the old code left it. Nothing writes these any more.
async function insertVoted(id: string, status: string, vote: string | null, photos: string | null = null, key?: string) {
  await db
    .prepare(
      `INSERT INTO bills (id, guild_id, channel_id, payer_id, status, created_at, receipt_key, kind, vote, photo_urls)
       VALUES (?, 'guild-1', 'chan-1', 'gavin', ?, '2026-10-29', ?, 'log', ?, ?)`,
    )
    .bind(id, status, key ?? (await receiptKey()), vote, photos)
    .run();
}

describe("/log", () => {
  it("answers privately and hands back a link, with nothing in the channel yet", async () => {
    const response = await run(slashLog());
    expect(await response.json()).toEqual({ type: 5, data: { flags: EPHEMERAL } });
    expect(lastReply().content).toBe("Pick what you had.\nSaigon Kitchen, $30.00 on the receipt.");
    expect(lastReply().components[0].components[0].label).toBe("Pick your items");
    expect(posts()).toHaveLength(0);
    const bill = await db.prepare("SELECT kind, status FROM bills").first();
    expect(bill).toEqual({ kind: "log", status: "draft" });
  });

  it("refuses with no photo", async () => {
    const response: any = await (await run(slashLog("gavin", { data: { id: "c", name: "log", type: 1, options: [], resolved: {} } }))).json();
    expect(response.data.content).toBe("I need a photo of the receipt. Attach it to /log.");
  });

  it.each([
    ["Send Messages", 1n << 11n],
    ["View Channel", 1n << 10n],
  ])("won't start in a channel where it lacks %s, before paying for a read", async (_, missing) => {
    const response: any = await (await run(slashLog("gavin", { app_permissions: String(VIEW_SEND & ~missing) }))).json();
    expect(response.data).toEqual({ content: "I can't post in this channel, so I can't log here. Run /log in a channel I can post in.", flags: EPHEMERAL });
    expect(calls).toHaveLength(0);
  });

  it("doesn't need Attach Files", async () => {
    await run(slashLog("gavin", { app_permissions: String(VIEW_SEND) }));
    expect(lastReply().content).toContain("Pick what you had.");
  });

  it("asks for Send Messages in Threads in a thread instead", async () => {
    const threads = (VIEW_SEND & ~(1n << 11n)) | (1n << 38n);
    await run(slashLog("gavin", { app_permissions: String(threads), channel: { id: "chan-1", type: 11 } }));
    expect(lastReply().content).toContain("Pick what you had.");
  });

  it.each([
    ["past the 8 hours", { bill_date: "2026-10-29", printed_time: "10:00 AM" }, "Too late to log this one. The receipt reads Oct 29, 10:00 AM. You have 8 hours from the time on the receipt."],
    ["from another day with no time", { bill_date: "2026-10-28", printed_time: null }, "Too late to log this one. The receipt reads Oct 28. It has no time printed, so it has to be from today."],
    ["from the future", { bill_date: "2026-11-12" }, "Not logged. This receipt reads Nov 12, which hasn't happened yet. Try a sharper photo."],
    ["with no date", { bill_date: null }, "Not logged. I can't find a date on this receipt."],
    ["with no total", { printed_total: null }, "Not logged. I can't find a total on this receipt."],
  ])("saves nothing for a receipt %s", async (_, fields, copy) => {
    read = { ...LUNCH, ...fields };
    await run(slashLog());
    expect(lastReply().content).toBe(copy);
    expect(lastReply().components).toBeUndefined();
    expect(await billCount()).toBe(0);
  });

  it("spends a read from the same limit as /split, one for each /log", async () => {
    await db.prepare("INSERT INTO receipt_reads (user_id, read_at, day, photos) VALUES ('gavin', ?, '2026-10-29', 4)").bind(NOW - 60_000).run();
    await run(slashLog());
    expect(lastReply().content).toContain("Pick what you had.");
    calls = [];

    const refused: any = await (await run(slashLog())).json();
    expect(refused.data).toEqual({ content: "You've read a lot of receipts lately. Try again later.", flags: EPHEMERAL });
    expect(calls).toHaveLength(0);
  });

  it("spends no read in a channel it can't post in", async () => {
    await run(slashLog("gavin", { app_permissions: "0" }));
    expect(await db.prepare("SELECT COUNT(*) AS n FROM receipt_reads").first()).toEqual({ n: 0 });
  });

  it("says the same as /split when the read fails", async () => {
    read = { ...LUNCH, is_receipt: false };
    await run(slashLog());
    expect(lastReply().content).toContain("I couldn't read a receipt in that photo.");
    expect(await billCount()).toBe(0);
  });

  it("clears the same receipt's older draft, so one receipt leaves one draft", async () => {
    await startLog();
    await startLog();
    expect(await billCount()).toBe(1);
  });
});

describe("logging", () => {
  it("goes through with one person on it, and tells the channel", async () => {
    const d = await startLog();
    await pick(d);
    expect((await logIt(d)).status).toBe(200);

    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.url).toContain("/channels/chan-1/messages");
    expect(posts()[0]!.body).toEqual({ content: "<@gavin> spent $20.00 at Saigon Kitchen\ngavin earned 初席 First Seat.", allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS });
    const bill = (await getBill(db, d.id))!;
    expect(bill).toMatchObject({ status: "confirmed", messageId: "msg-post" });
    expect((await getShares(db, d.id)).map((s) => [s.participant, s.owedCents])).toEqual([["gavin", 2000]]);
  });

  it("counts toward what they spent but not as hosting anyone", async () => {
    await logged();
    expect((await personSummary(db, "guild-1", "gavin"))!).toMatchObject({ spentCents: 2000, outings: 1 });
    const profile = (await personProfile(db, "guild-1", "gavin", NOW))!;
    expect(profile.frontedCents).toBe(0);
    const boards = await serverBoards(db, "guild-1", NOW);
    expect(boards.lists["spent:month"].map((r) => r.id)).toEqual(["gavin"]);
    expect(boards.lists["hosted:month"]).toEqual([]);
  });

  it("escapes the name, so a receipt can't format the post", async () => {
    read = { ...LUNCH, place: "**Bold** @everyone" };
    await logged();
    expect(posts()[0]!.body.content).toBe("<@gavin> spent $20.00 at \\*\\*Bold\\*\\* @everyone\ngavin earned 初席 First Seat.");
    expect(posts()[0]!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it("won't log nothing", async () => {
    const d = await startLog();
    const refused = await logIt(d);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "Pick what you had." });
    expect(posts()).toHaveLength(0);
  });

  it("won't log more than the receipt's total", async () => {
    read = { ...LUNCH, items: [{ label: "Pho", price: "40.00", confidence: 0.9 }], tax: null, printed_total: "30.00" };
    const d = await startLog();
    await pick(d);
    const refused = await logIt(d);
    expect(await refused.json()).toMatchObject({ error: "Your items add up to more than the receipt's total." });
  });

  it("logs lines that don't add up, which only warn", async () => {
    read = { ...LUNCH, printed_total: "31.00" };
    const d = await startLog();
    await pick(d);
    expect((await logIt(d)).status).toBe(200);
  });

  it("stands when the post fails, and the page says so", async () => {
    const d = await startLog();
    await pick(d);
    channelFailures = 1;
    const state: any = await (await logIt(d)).json();
    expect(state).toMatchObject({ status: "confirmed", postMissing: true });
  });

  it("takes everything at once and gives it back", async () => {
    const d = await startLog();
    const all: any = await (await web(`${d.path}/everything`, d.token, "POST", { claimed: true })).json();
    expect(all.result.shares[0].owedCents).toBe(3000);
    const none: any = await (await web(`${d.path}/everything`, d.token, "POST", { claimed: false })).json();
    expect(none.items.every((i: any) => i.claimedBy.length === 0)).toBe(true);
  });
});

describe("a place the read couldn't name", () => {
  beforeEach(() => {
    read = { ...LUNCH, place: null };
  });

  it("asks for it, and won't log until it's typed", async () => {
    const d = await startLog();
    expect(lastReply().content).toBe("I couldn't read the name of this place.\nType it in on the next page.");
    await pick(d);
    expect(await (await logIt(d)).json()).toMatchObject({ error: "Add the name of this place." });

    const named: any = await (await web(d.path, d.token, "PATCH", { place: "  Pho\n Hoa  " })).json();
    expect(named.place).toBe("Pho Hoa");
    expect((await logIt(d)).status).toBe(200);
    expect(posts()[0]!.body.content).toBe("<@gavin> spent $20.00 at Pho Hoa\ngavin earned 初席 First Seat.");
  });

  it("refuses an empty name", async () => {
    const d = await startLog();
    expect((await web(d.path, d.token, "PATCH", { place: "   " })).status).toBe(400);
  });
});

describe("one receipt credits once", () => {
  it("refuses a second person", async () => {
    await logged("gavin");
    await run(slashLog("marcus"));
    expect(lastReply().content).toBe("This receipt was already logged.");
    expect(await billCount()).toBe(1);
  });

  it("tells you when it was you", async () => {
    await logged("gavin");
    await run(slashLog("gavin"));
    expect(lastReply().content).toBe("You already logged this receipt.");
  });

  it("lets the database settle two drafts of one receipt", async () => {
    const first = await startLog("gavin");
    const second = await startLog("marcus");
    await pick(first, "gavin");
    await pick(second, "marcus");
    expect((await logIt(first)).status).toBe(200);
    const refused = await logIt(second);
    expect(await refused.json()).toMatchObject({ error: "This receipt was already logged." });
    expect(posts()).toHaveLength(1);
  });

  it("holds a no-time receipt to one log for each person", async () => {
    read = { ...LUNCH, bill_date: "2026-10-29", printed_time: null };
    await logged("gavin");
    await run(slashLog("gavin"));
    expect(lastReply().content).toBe("You already logged this receipt.");
  });

  it("gives the receipt back after an Undo", async () => {
    const d = await logged();
    await web(d.path, d.token, "DELETE", { paid: "0.00" });
    await startLog();
    expect(lastReply().content).toContain("Pick what you had.");
  });
});

describe("a log and a /split of the same receipt", () => {
  async function confirmedSplit(people: string[]): Promise<string> {
    const id = crypto.randomUUID();
    const key = await db.prepare("SELECT receipt_key FROM bills LIMIT 1").first<{ receipt_key: string | null }>();
    await db.batch([
      db.prepare("INSERT INTO bills (id, guild_id, channel_id, payer_id, status, created_at, receipt_key) VALUES (?, 'guild-1', 'chan-1', ?, 'draft', '2026-10-29', ?)").bind(id, people[0], key?.receipt_key ?? null),
      ...people.flatMap((p, i) => [
        db.prepare("INSERT INTO participants (bill_id, id, kind, display_name, added_by) VALUES (?, ?, 'member', ?, NULL)").bind(id, p, p),
        db.prepare("INSERT INTO bill_items (id, bill_id, label, cents, position, source) VALUES (?, ?, 'Pho', 1000, ?, 'ocr')").bind(`${id}-${i}`, id, i),
        db.prepare("INSERT INTO item_claims (bill_item_id, participant_id) VALUES (?, ?)").bind(`${id}-${i}`, p),
      ]),
      db.prepare("UPDATE bills SET printed_total_cents = ? WHERE id = ?").bind(people.length * 1000, id),
    ]);
    const token = await mintToken(id, people[0]!, "unused-in-these-tests", NOW);
    const { revision } = (await getBill(db, id))!;
    expect((await web(`/b/${id}/confirm`, token, "POST", { revision })).status).toBe(200);
    return id;
  }

  it("refuses a log of a receipt already split", async () => {
    await startLog();
    await confirmedSplit(["gavin", "marcus"]);
    await run(slashLog("priya"));
    expect(lastReply().content).toBe("This receipt was already split.");
  });

  it("removes the logs of the people on the split, post included", async () => {
    const d = await logged("gavin");
    await confirmedSplit(["gavin", "marcus"]);
    expect((await getBill(db, d.id))!.status).toBe("deleted");
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/channels/chan-1/messages/msg-post"))).toBe(true);
    expect((await personSummary(db, "guild-1", "gavin"))!.spentCents).toBe(1000);
  });

  it("leaves the log of someone not on the split", async () => {
    const d = await logged("priya");
    await confirmedSplit(["gavin", "marcus"]);
    expect((await getBill(db, d.id))!.status).toBe("confirmed");
  });

  it("refuses Log it on a draft whose receipt was split since", async () => {
    const d = await startLog("priya");
    await pick(d, "priya");
    await confirmedSplit(["gavin", "marcus"]);
    expect(await (await logIt(d)).json()).toMatchObject({ error: "This receipt was already split." });
  });
});

describe("the rest of a split doesn't reach a log", () => {
  it.each([
    ["POST", "/item", { op: "add", label: "Beer", price: "9000.00" }],
    ["POST", "/guest", { name: "Sam" }],
    ["PATCH", "/guest/g1", { name: "Sam" }],
    ["DELETE", "/guest/g1", undefined],
    ["POST", "/guest/g1/paid", { paid: true }],
    ["DELETE", "/member/marcus", undefined],
    ["POST", "/venmo", { username: "gavin" }],
    ["POST", "/pardon", { participantId: "gavin", pardoned: true }],
    ["POST", "/reopen", undefined],
    ["POST", "/payment", { id: "payment-1", amount: "1.00" }],
    ["POST", "/paid/marcus", { id: "payment-1", amount: "1.00" }],
    ["DELETE", "/paid/marcus", undefined],
    ["PATCH", "", { tax: "0.00" }],
    ["PATCH", "", { printedTotal: "9000.00" }],
    ["PATCH", "", { payer: "marcus" }],
  ])("refuses %s %s", async (method, path, body) => {
    const d = await startLog();
    const before = (await getBill(db, d.id))!;
    const response = await web(`${d.path}${path}`, d.token, method, body);
    expect(response.status).toBe(409);
    expect(await getBill(db, d.id)).toEqual(before);
  });

  it("won't split the open lines on a log", async () => {
    const d = await startLog();
    await pick(d);
    const { revision } = (await getBill(db, d.id))!;
    expect((await web(`${d.path}/confirm`, d.token, "POST", { revision, splitUnclaimed: true })).status).toBe(409);
  });

  it("opens to nobody but the person logging", async () => {
    const d = await startLog();
    const theirs = await mintToken(d.id, "marcus", "unused-in-these-tests", NOW);
    expect((await web(`${d.path}/state`, theirs)).status).toBe(403);
    expect((await web(`${d.path}/everything`, theirs, "POST", { claimed: true })).status).toBe(403);
    const page = await app.fetch(new Request(`https://aazhi.test${d.path}?t=${theirs}`), env(), createExecutionContext());
    expect(page.status).toBe(403);
  });

  it("won't take a claim for someone else", async () => {
    const d = await startLog();
    const [item] = await getBillItems(db, d.id);
    const response = await web(`${d.path}/claim`, d.token, "POST", { itemId: item!.id, participantId: "marcus", claimed: true });
    expect(response.status).toBe(400);
  });
});

describe("after logging", () => {
  it("fixes the name and the post with it, keeping the post quiet", async () => {
    const d = await logged();
    const state: any = await (await web(d.path, d.token, "PATCH", { place: "Pho Hoa" })).json();
    expect(state.place).toBe("Pho Hoa");
    const edit = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/channels/chan-1/messages/msg-post"))!;
    expect(edit.body).toEqual({ content: "<@gavin> spent $20.00 at Pho Hoa\ngavin earned 初席 First Seat.", allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS });
  });

  it("undoes the log and the post", async () => {
    const d = await logged();
    const undone = await web(d.path, d.token, "DELETE", { paid: "0.00" });
    expect(await undone.json()).toEqual({ deleted: true });
    expect((await getBill(db, d.id))!.status).toBe("deleted");
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/messages/msg-post"))).toBe(true);
    expect(await personSummary(db, "guild-1", "gavin")).toBeNull();
  });

  it("undoes the log even if the post won't go, and says so", async () => {
    const d = await logged();
    channelFailures = 1;
    expect(await (await web(d.path, d.token, "DELETE", { paid: "0.00" })).json()).toEqual({ deleted: true, postLeft: true });
    expect((await getBill(db, d.id))!.status).toBe("deleted");
  });

  it("discards a draft without leaving a row", async () => {
    const d = await startLog();
    expect((await web(d.path, d.token, "DELETE", { paid: "0.00" })).status).toBe(200);
    expect(await billCount()).toBe(0);
    expect(posts()).toHaveLength(0);
  });
});

describe("the fake check", () => {
  it("refuses a fake privately, before the items page, and saves nothing", async () => {
    check = () => answer(FAKE);
    const response = await run(slashLog());
    expect(await response.json()).toEqual({ type: 5, data: { flags: EPHEMERAL } });
    expect(lastReply()).toEqual({ content: "This receipt looks fake, so I didn't log it.", allowed_mentions: { parse: [] } });
    expect(await billCount()).toBe(0);
    expect(posts()).toHaveLength(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM stamps").first<{ n: number }>())!.n).toBe(0);
  });

  it("refuses when the check fails, and asks for another try", async () => {
    check = () => new Response("no", { status: 500 });
    await run(slashLog());
    expect(lastReply()).toEqual({ content: "I couldn't check this receipt, so try again.", allowed_mentions: { parse: [] } });
    expect(await billCount()).toBe(0);
    expect(posts()).toHaveLength(0);
  });

  it("takes a retry once a clearer photo passes", async () => {
    check = () => answer(FAKE);
    await run(slashLog());
    check = () => answer(REAL);
    await run(slashLog());
    expect(lastReply().content).toContain("Pick what you had.");
  });

  it("answers before the read does", async () => {
    let finishRead = () => {};
    const stalled = new Promise<void>((resolve) => (finishRead = resolve));
    const stub = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://api.anthropic.com") && !JSON.parse(String(init!.body)).output_config) await stalled;
      const response = await stub(input, init);
      if (String(input).includes("/webhooks/")) finishRead();
      return response;
    });
    check = () => answer(FAKE);
    await run(slashLog());
    expect(replies().map((r) => r.body.content)).toEqual(["This receipt looks fake, so I didn't log it."]);
  });

  it("no longer holds a receipt voted fake, which the check now decides", async () => {
    await insertVoted("voted-fake", "deleted", "fake");
    await run(slashLog("marcus"));
    expect(lastReply().content).toContain("Pick what you had.");
  });
});

describe("the old vote", () => {
  it.each(["real", "fake"] as const)("answers a tap on %s and changes nothing", async (side) => {
    const d = await logged();
    const before = await getBill(db, d.id);
    const tap: any = await (await press(side, d.id, "marcus")).json();
    expect(tap).toEqual({ type: 4, data: { content: "This vote is over.", flags: EPHEMERAL } });
    expect(await getBill(db, d.id)).toEqual(before);
  });

  describe("the migration", () => {
    const close = async () => {
      const migration = workerEnv.TEST_MIGRATIONS.find((m) => m.name.startsWith("0011"))!;
      for (const query of migration.queries) await db.prepare(query).run();
    };
    const row = (id: string) => db.prepare("SELECT status, vote, photo_urls FROM bills WHERE id = ?").bind(id).first();

    it("closes an open vote so it counts for nothing and frees the receipt", async () => {
      await insertVoted("open-one", "draft", "open");
      await close();
      expect(await row("open-one")).toEqual({ status: "deleted", vote: null, photo_urls: null });
      expect(await personSummary(db, "guild-1", "gavin")).toBeNull();
      await logged("marcus");
      expect((await personSummary(db, "guild-1", "marcus"))!.spentCents).toBe(2000);
    });

    it("removes a draft the old check flagged, which could otherwise be logged", async () => {
      await insertVoted("flagged", "draft", null, '["https://cdn.discordapp.com/r.jpg"]');
      await close();
      expect(await row("flagged")).toEqual({ status: "deleted", vote: null, photo_urls: null });
    });

    it("leaves the receipts that were already voted on", async () => {
      await insertVoted("won", "confirmed", "real");
      await insertVoted("lost", "deleted", "fake", null, "other-key");
      await close();
      expect(await row("won")).toEqual({ status: "confirmed", vote: "real", photo_urls: null });
      expect(await row("lost")).toEqual({ status: "deleted", vote: "fake", photo_urls: null });
    });

    it("can run twice", async () => {
      await insertVoted("open-one", "draft", "open");
      await close();
      const once = await db.prepare("SELECT revision FROM bills WHERE id = 'open-one'").first();
      await close();
      expect(await db.prepare("SELECT revision FROM bills WHERE id = 'open-one'").first()).toEqual(once);
    });
  });
});

describe("the log page", () => {
  const open = async (d: Draft) => (await app.fetch(new Request(`https://aazhi.test${d.path}?t=${d.token}`), env(), createExecutionContext())).text();

  it("is the items and Log it, with nobody else on it", async () => {
    const html = await open(await startLog());
    const body = html.slice(html.indexOf("<body"), html.indexOf("<script"));
    expect(body).toContain("Pick what you had.");
    expect(body).toContain("Log it");
    for (const split of ["data-open-payer", "data-add-guest", "Add a line", "data-person="]) expect(body).not.toContain(split);
  });

  it("asks for the name where the read found none", async () => {
    read = { ...LUNCH, place: null };
    const html = await open(await startLog());
    expect(html).toContain("I couldn't read the name of this place.");
  });

  it("never mentions a vote", async () => {
    const d = await startLog();
    const body = await open(d);
    expect(body).not.toContain("Up for a vote");
    const state: any = await (await web(`${d.path}/state`, d.token)).json();
    expect(state).not.toHaveProperty("vote");
  });
});

describe("Your logs", () => {
  const viewer = (id = "gavin", guild = "guild-1") => mintViewerToken(guild, id, null, "unused-in-these-tests", NOW);

  it("shows on your own profile and nobody else's", async () => {
    await logged();
    const open = async (path: string, token: string) => (await app.fetch(new Request(`https://aazhi.test${path}?t=${token}`), env(), createExecutionContext())).text();
    const mine = await open("/g/guild-1", await viewer());
    expect(mine).toContain("Your logs");
    expect(mine).toContain("Saigon Kitchen");
    expect(mine).toContain("$20.00");
    expect(await open("/g/guild-1/u/gavin", await viewer("marcus"))).not.toContain("Your logs");
  });

  it("keeps a stamp's line on the post through a rename, and earns it only once", async () => {
    const d = await startLog();
    await pick(d);
    await logIt(d);
    expect(posts()[0]!.body.content).toContain("earned 初席 First Seat.");
    const token = await mintViewerToken("guild-1", "gavin", null, env().TOKEN_SIGNING_KEY, Date.now());
    await web(`/g/guild-1/logs/${d.id}`, token, "PATCH", { place: "Pho Hoa" });
    const edit = calls.at(-1)!;
    expect(edit.body.content).toBe("<@gavin> spent $20.00 at Pho Hoa\ngavin earned 初席 First Seat.");
  });

  it("renames and removes from any server, once the page's link is gone", async () => {
    const d = await logged();
    const token = await viewer("gavin", "guild-2");
    const renamed = await web(`/g/guild-2/logs/${d.id}`, token, "PATCH", { place: "Pho Hoa" });
    expect(await renamed.json()).toEqual({ place: "Pho Hoa" });
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/messages/msg-post"))).toBe(true);

    const removed = await web(`/g/guild-2/logs/${d.id}`, token, "DELETE");
    expect(await removed.json()).toEqual({ deleted: true });
    expect((await getBill(db, d.id))!.status).toBe("deleted");
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/messages/msg-post"))).toBe(true);
  });

  it("refuses anyone else's log", async () => {
    const d = await logged();
    const token = await viewer("marcus");
    expect((await web(`/g/guild-1/logs/${d.id}`, token, "PATCH", { place: "Mine now" })).status).toBe(403);
    expect((await web(`/g/guild-1/logs/${d.id}`, token, "DELETE")).status).toBe(403);
    expect((await getBill(db, d.id))!.place).toBe("Saigon Kitchen");
  });
});
