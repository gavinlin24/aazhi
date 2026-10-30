import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import {
  addClaim,
  addParticipant,
  createBill,
  getBill,
  getBillItems,
  getParticipants,
  insertItems,
  openDraftInChannel,
  type BillRow,
  type NewBill,
} from "../../src/db/bills";
import type { Env } from "../../src/env";
import { personSummary, serverBoards } from "../../src/db/stats";
import { EXTRACT_TOOL_NAME } from "../../src/extract/schema";
import { editBillMessage, ephemeral, followUp } from "../../src/discord/rest";
import { PATTY_SHACK } from "../fixtures/modifiers";
import { SAIGON } from "../fixtures/saigon";
import { generateKeypair, signedRequest, testEnv, type TestKeypair } from "./helpers";

const db = workerEnv.DB;
const API = "https://discord.com/api/v10";
const APP_ID = "app-1";
const TOKEN = "interaction-token-1";
const RECEIPT_URL = "https://cdn.discordapp.com/attachments/1/2/receipt.jpg";
const EPHEMERAL = 1 << 6;

let keypair: TestKeypair;
const ready = generateKeypair().then((k) => (keypair = k));

function env(): Env {
  return {
    ...testEnv(keypair?.publicKeyHex ?? "00"),
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_APPLICATION_ID: APP_ID,
    ANTHROPIC_API_KEY: "anthropic-key",
  };
}

function price(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function saigonToolInput(overrides: Record<string, unknown> = {}) {
  return {
    is_receipt: true,
    readable: true,
    place: "Saigon Kitchen",
    bill_date: "2026-10-28",
    items: SAIGON.items.map((item) => ({ label: item.label, price: price(item.cents), confidence: 0.95 })),
    discount: null,
    tax: "22.32",
    printed_total: "273.82",
    ...overrides,
  };
}

function toolUse(input: unknown): Response {
  return Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_1", name: EXTRACT_TOOL_NAME, input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: any;
}

let calls: Call[];
let anthropic: (init?: RequestInit) => Response | Promise<Response>;
let discordFailures: number;

function discordCalls(): Call[] {
  return calls.filter((c) => c.url.startsWith(API));
}

function anthropicCalls(): Call[] {
  return calls.filter((c) => c.url.startsWith("https://api.anthropic.com"));
}

// Everything a message shows, so a test can read it the way a person would.
function shown(body: any): string {
  const embeds = (body.embeds ?? []) as any[];
  return [
    body.content ?? "",
    ...embeds.flatMap((e) => [e.title, e.description, ...(e.fields ?? []).flatMap((f: any) => [f.name, f.value]), e.footer?.text]),
  ]
    .filter(Boolean)
    .join("\n");
}

function customIds(body: any): string[] {
  return ((body.components ?? []) as any[]).flatMap((row) => row.components.map((c: any) => c.custom_id));
}

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
  calls = [];
  discordFailures = 0;
  anthropic = () => toolUse(saigonToolInput());
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.startsWith("https://api.anthropic.com")) return anthropic(init);
    if (discordFailures > 0) {
      discordFailures--;
      return new Response("upstream sad", { status: 500 });
    }
    const channel = /\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(url);
    if (channel) return Response.json({ id: channel[2], channel_id: channel[1] });
    return Response.json({ id: "msg-new", channel_id: "chan-1" });
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The background work waits out the edit window on a timer; advancing fake
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
  await work;
}

const MEMBER = {
  user: { id: "gavin", username: "gavin_l", global_name: "Gavin Lin", discriminator: "0", avatar: null },
  nick: "Gavin",
  roles: [],
  joined_at: "2020-01-01T00:00:00.000Z",
  deaf: false,
  mute: false,
  flags: 0,
  permissions: "0",
};

function attachment(id: string, url: string, contentType: string | undefined) {
  return { id, filename: url.split("/").pop(), size: 1000, url, proxy_url: url, content_type: contentType };
}

function slashSplit(
  files: { option: string; url: string; contentType?: string }[] = [{ option: "receipt", url: RECEIPT_URL }],
  member: unknown = MEMBER,
) {
  const attachments = Object.fromEntries(
    files.map((f, i) => [`att-${i}`, attachment(`att-${i}`, f.url, "contentType" in f ? f.contentType : "image/jpeg")]),
  );
  return {
    id: "int-1",
    application_id: APP_ID,
    type: 2,
    token: TOKEN,
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    channel: { id: "chan-1", type: 0 },
    member,
    data: {
      id: "cmd-1",
      name: "split",
      type: 1,
      options: files.map((f, i) => ({ name: f.option, type: 11, value: `att-${i}` })),
      resolved: { attachments },
    },
  };
}

function messageSplit(files: { url: string; contentType?: string }[], member: unknown = MEMBER) {
  return {
    id: "int-2",
    application_id: APP_ID,
    type: 2,
    token: TOKEN,
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    channel: { id: "chan-1", type: 0 },
    member,
    data: {
      id: "cmd-2",
      name: "Split this receipt",
      type: 3,
      target_id: "posted-1",
      resolved: {
        messages: {
          "posted-1": {
            id: "posted-1",
            channel_id: "chan-1",
            content: "",
            attachments: files.map((f, i) => attachment(`m-${i}`, f.url, f.contentType)),
          },
        },
      },
    },
  };
}

async function invoke(body: unknown): Promise<{ response: Response; background: Promise<void> }> {
  await ready;
  const ctx = createExecutionContext();
  const response = await app.fetch(await signedRequest(keypair, body), env(), ctx);
  return { response, background: waitOnExecutionContext(ctx) };
}

async function run(body: unknown): Promise<Response> {
  const { response, background } = await invoke(body);
  await settle(background);
  return response;
}

function originalEdits(): Call[] {
  return discordCalls().filter((c) => c.url === `${API}/webhooks/${APP_ID}/${TOKEN}/messages/@original`);
}

function newBill(id: string, overrides: Partial<NewBill> = {}): NewBill {
  return {
    id,
    guildId: "guild-1",
    channelId: "chan-1",
    messageId: "msg-old",
    payerId: "dani",
    place: "Pho Place",
    billDate: "2026-10-20",
    discountCents: 0,
    taxCents: 100,
    tipCents: 0,
    printedTotalCents: 1100,
    status: "draft",
    ...overrides,
  };
}

async function seedDraft(id: string, overrides: Partial<NewBill> = {}): Promise<BillRow> {
  const bill = await createBill(db, newBill(id, overrides));
  await addParticipant(db, { billId: id, id: "dani", kind: "member", displayName: "Dani", addedBy: null });
  await addParticipant(db, { billId: id, id: "marcus", kind: "member", displayName: "Marcus", addedBy: null });
  await insertItems(db, id, [{ id: `${id}-pho`, label: "Pho", cents: 1000, source: "ocr", confidence: 0.9 }]);
  return (await getBill(db, bill.id))!;
}

describe("/split", () => {
  it("defers within the interaction deadline rather than waiting on extraction", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    anthropic = async () => {
      await gate;
      return toolUse(saigonToolInput());
    };

    const { response, background } = await invoke(slashSplit());

    expect(await response.json()).toEqual({ type: 5 });
    expect(anthropicCalls()).toHaveLength(1);
    expect(originalEdits()).toHaveLength(0);

    release();
    await settle(background);
    expect(originalEdits()).toHaveLength(1);
  });

  it("creates a draft bill and posts a message with provisional amounts and no pay controls", async () => {
    await run(slashSplit());

    const bill = await openDraftInChannel(db, "chan-1");
    expect(bill).toMatchObject({
      guildId: "guild-1",
      channelId: "chan-1",
      messageId: "msg-new",
      payerId: "gavin",
      place: "Saigon Kitchen",
      billDate: "2026-10-28",
      discountCents: 0,
      taxCents: 2232,
      tipCents: 0,
      printedTotalCents: 27382,
      status: "draft",
    });
    expect(await getParticipants(db, bill!.id)).toEqual([
      { billId: bill!.id, id: "gavin", kind: "member", displayName: "Gavin", addedBy: null },
    ]);
    const items = await getBillItems(db, bill!.id);
    expect(items.map((i) => [i.label, i.cents, i.claimedBy])).toEqual(SAIGON.items.map((i) => [i.label, i.cents, []]));
    const stored = await db
      .prepare("SELECT DISTINCT source, confidence FROM bill_items WHERE bill_id = ?")
      .bind(bill!.id)
      .all();
    expect(stored.results).toEqual([{ source: "ocr", confidence: 0.95 }]);

    expect(anthropicCalls()[0]!.body.messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "url", url: RECEIPT_URL },
    });

    const [post] = originalEdits();
    expect(post!.method).toBe("PATCH");
    const text = shown(post!.body);
    expect(text).toContain("Saigon Kitchen");
    expect(text).toMatch(/Total \$273\.82/);
    expect(text).toMatch(/Gavin paid · 1 person/);
    expect(text).toMatch(/\$273\.82 unclaimed/);
    expect(customIds(post!.body)).toEqual([`open:${bill!.id}`, `roster:${bill!.id}`]);
    expect(JSON.stringify(post!.body.components)).not.toMatch(/pay|settle/i);
    expect(post!.body.allowed_mentions).toEqual({ parse: [] });
    // Nothing else to edit: there was no older draft here.
    expect(discordCalls()).toHaveLength(1);
  });

  it("keeps a dish and its modifiers one claimable line, so the bill adds up as printed", async () => {
    anthropic = () => toolUse(PATTY_SHACK);

    await run(slashSplit());

    const bill = await openDraftInChannel(db, "chan-1");
    const items = await getBillItems(db, bill!.id);
    expect(items.map((i) => [i.label, i.cents, i.addons])).toEqual([
      [
        "Classic Burger",
        1950,
        [
          { label: "Medium Rare", cents: 0 },
          { label: "Extra Patty", cents: 300 },
          { label: "Add Bacon", cents: 250 },
          { label: "No Onions", cents: 0 },
        ],
      ],
      ["Veggie Burger", 1500, [{ label: "Gluten Free Bun", cents: 200 }, { label: "No Pickles", cents: 0 }]],
      ["Fries", 650, [{ label: "Truffle Oil", cents: 150 }]],
      ["Soda", 600, undefined],
    ]);
    expect(shown(originalEdits()[0]!.body)).toContain("Total $51.17");
  });

  it("puts a whole-bill discount on the bill rather than among the lines", async () => {
    anthropic = () => toolUse(saigonToolInput({ discount: "-25.15", printed_total: "248.67" }));
    await run(slashSplit());

    const bill = await openDraftInChannel(db, "chan-1");
    expect(bill).toMatchObject({ discountCents: 2515, printedTotalCents: 24867 });
    const items = await getBillItems(db, bill!.id);
    expect(items.map((i) => i.cents)).toEqual(SAIGON.items.map((i) => i.cents));

    const text = shown(originalEdits()[0]!.body);
    expect(text).toMatch(/Total \$248\.67/);
    expect(text).not.toMatch(/do not add up/);
  });

  it("supersedes an existing open draft in the same channel", async () => {
    await seedDraft("old");
    await seedDraft("elsewhere", { channelId: "chan-2", messageId: "msg-elsewhere" });

    await run(slashSplit());

    expect((await getBill(db, "old"))!.status).toBe("superseded");
    expect((await getBill(db, "elsewhere"))!.status).toBe("draft");
    const fresh = await openDraftInChannel(db, "chan-1");
    expect(fresh!.id).not.toBe("old");

    const oldEdits = discordCalls().filter((c) => c.url === `${API}/channels/chan-1/messages/msg-old`);
    expect(oldEdits).toHaveLength(1);
    expect(oldEdits[0]!.method).toBe("PATCH");
    expect(oldEdits[0]!.auth).toBe("Bot bot-token");
    expect(oldEdits[0]!.body.components).toEqual([]);
    expect(shown(oldEdits[0]!.body)).toMatch(/newer split.*replaced/i);
    expect(discordCalls().some((c) => c.url.includes("msg-elsewhere"))).toBe(false);
  });

  it("leaves a reopened bill alone, since it was confirmed once and may hold payments", async () => {
    await seedDraft("reopened");
    await db.prepare("UPDATE bills SET confirmed_at = ? WHERE id = ?").bind("2026-10-27T00:00:00.000Z", "reopened").run();

    await run(slashSplit());

    expect(originalEdits()).toHaveLength(1);
    expect((await getBill(db, "reopened"))!.status).toBe("draft");
    expect(discordCalls().some((c) => c.url.includes("msg-old"))).toBe(false);
  });

  it("names the invoker by global name when they have no server nickname", async () => {
    await run(slashSplit(undefined, { ...MEMBER, nick: null }));
    const bill = await openDraftInChannel(db, "chan-1");
    expect((await getParticipants(db, bill!.id))[0]!.displayName).toBe("Gavin Lin");
  });

  it("names the invoker by username when they have neither", async () => {
    await run(slashSplit(undefined, { ...MEMBER, nick: null, user: { ...MEMBER.user, global_name: null } }));
    const bill = await openDraftInChannel(db, "chan-1");
    expect((await getParticipants(db, bill!.id))[0]!.displayName).toBe("gavin_l");
  });

  it("reads the extra pages in receipt, page 2, page 3 order", async () => {
    await run(
      slashSplit([
        { option: "page_3", url: "https://cdn.discordapp.com/3.jpg" },
        { option: "receipt", url: "https://cdn.discordapp.com/1.jpg" },
        { option: "page_2", url: "https://cdn.discordapp.com/2.jpg" },
      ]),
    );

    const images = anthropicCalls()[0]!.body.messages[0].content.filter((c: any) => c.type === "image");
    expect(images.map((c: any) => c.source.url)).toEqual([
      "https://cdn.discordapp.com/1.jpg",
      "https://cdn.discordapp.com/2.jpg",
      "https://cdn.discordapp.com/3.jpg",
    ]);
  });

  it("explains how to attach the photo, without deferring, when no image came with the command", async () => {
    const response = await run(
      slashSplit([{ option: "receipt", url: "https://cdn.discordapp.com/receipt.pdf", contentType: "application/pdf" }]),
    );

    const json = (await response.json()) as any;
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(EPHEMERAL);
    expect(json.data.content).toMatch(/photo/i);
    expect(json.data.content).toMatch(/Split this receipt/);
    expect(calls).toHaveLength(0);
    expect(await openDraftInChannel(db, "chan-1")).toBeNull();
  });

  it("tells the payer what it misread", async () => {
    anthropic = () =>
      toolUse(
        saigonToolInput({
          items: SAIGON.items.map((item) =>
            item.id === "noodles"
              ? { label: item.label, price: "82.00", confidence: 0.41 }
              : { label: item.label, price: price(item.cents), confidence: item.id === "comtam" ? 0.6 : 0.97 },
          ),
        }),
      );

    await run(slashSplit());

    const bill = await openDraftInChannel(db, "chan-1");
    expect(bill!.status).toBe("draft");
    const [post] = originalEdits();
    const text = shown(post!.body);
    expect(customIds(post!.body)).toEqual([`open:${bill!.id}`, `roster:${bill!.id}`]);
    expect(text).toContain("Receipt total $273.82");
    expect(text).toContain("Line items do not add up to total!");
  });

  it("asks for the total when the receipt's printed total could not be read", async () => {
    anthropic = () => toolUse(saigonToolInput({ printed_total: null }));

    await run(slashSplit());

    const bill = await openDraftInChannel(db, "chan-1");
    const [post] = originalEdits();
    expect(customIds(post!.body)).toEqual([`open:${bill!.id}`, `roster:${bill!.id}`]);
    expect(shown(post!.body)).toMatch(/Couldn't read the receipt total!/);
  });

  it.each([
    ["not-a-receipt", () => toolUse({ ...saigonToolInput(), is_receipt: false }), /couldn't read a receipt in that photo/i],
    ["unreadable", () => toolUse({ ...saigonToolInput(), readable: false }), /sharper.*flat|flat.*sharper/i],
    ["model-error", () => new Response("overloaded", { status: 529 }), /try again/i],
  ] as const)("on a %s read, says so plainly and creates no bill", async (_reason, reply, message) => {
    await seedDraft("old");
    anthropic = reply;

    await run(slashSplit());

    const [post] = originalEdits();
    expect(post!.body.content).toMatch(message);
    expect(post!.body.embeds ?? []).toEqual([]);
    expect(post!.body.components ?? []).toEqual([]);
    const { results } = await db.prepare("SELECT id, status FROM bills").all();
    expect(results).toEqual([{ id: "old", status: "draft" }]);
    expect(discordCalls().some((c) => c.url.includes("msg-old"))).toBe(false);
  });

  it("gives up on a receipt reader that never answers, well inside the background time limit", async () => {
    await seedDraft("old");
    // Like a real fetch that hangs: it ends only when its signal aborts.
    anthropic = (init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));

    const { background } = await invoke(slashSplit());
    await vi.advanceTimersByTimeAsync(19_000);
    expect(originalEdits()).toHaveLength(0);
    await settle(background);

    const [post] = originalEdits();
    expect(post!.body.content).toMatch(/try again/i);
    expect(anthropicCalls()).toHaveLength(1);
    const { results } = await db.prepare("SELECT id, status FROM bills").all();
    expect(results).toEqual([{ id: "old", status: "draft" }]);
  });

  it("says something went wrong rather than leaving the message thinking when the post fails", async () => {
    discordFailures = 1;

    await run(slashSplit());

    const edits = originalEdits();
    expect(edits).toHaveLength(2);
    expect(edits[1]!.body.content).toMatch(/went wrong/i);
  });
});

describe("Split this receipt (message command)", () => {
  it("splits the photos in the chosen message, in order, skipping anything that is not an image", async () => {
    const response = await run(
      messageSplit([
        { url: "https://cdn.discordapp.com/a.png", contentType: "image/png" },
        { url: "https://cdn.discordapp.com/notes.txt", contentType: "text/plain" },
        { url: "https://cdn.discordapp.com/b.jpg", contentType: "image/jpeg" },
        { url: "https://cdn.discordapp.com/mystery" },
      ]),
    );

    expect(await response.json()).toEqual({ type: 5 });
    const images = anthropicCalls()[0]!.body.messages[0].content.filter((c: any) => c.type === "image");
    expect(images.map((c: any) => c.source.url)).toEqual([
      "https://cdn.discordapp.com/a.png",
      "https://cdn.discordapp.com/b.jpg",
    ]);
    const bill = await openDraftInChannel(db, "chan-1");
    expect(bill).toMatchObject({ payerId: "gavin", messageId: "msg-new", status: "draft" });
  });

  it("explains how to use it when the message has no photos", async () => {
    const response = await run(messageSplit([{ url: "https://cdn.discordapp.com/notes.txt", contentType: "text/plain" }]));

    const json = (await response.json()) as any;
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(EPHEMERAL);
    expect(json.data.content).toMatch(/photo/i);
    expect(calls).toHaveLength(0);
  });
});

describe("editBillMessage", () => {
  function channelEdits(messageId = "msg-old"): Call[] {
    return discordCalls().filter((c) => c.url === `${API}/channels/chan-1/messages/${messageId}`);
  }

  it("coalesces rapid edits to one call per bill", async () => {
    const bill = await seedDraft("b1");

    const edits: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      edits.push(editBillMessage(bill, env()));
      await vi.advanceTimersByTimeAsync(200);
    }
    await settle(Promise.all(edits));

    expect(channelEdits()).toHaveLength(1);
    expect(channelEdits()[0]!.method).toBe("PATCH");
    expect(channelEdits()[0]!.auth).toBe("Bot bot-token");
    expect(channelEdits()[0]!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it("does not lose a change made while an edit was already waiting", async () => {
    const bill = await seedDraft("b1");

    const first = editBillMessage(bill, env());
    await vi.advanceTimersByTimeAsync(1000);
    await addClaim(db, "b1", "b1-pho", "marcus");
    const second = editBillMessage(bill, env());
    await settle(Promise.all([first, second]));

    expect(channelEdits()).toHaveLength(1);
    const text = shown(channelEdits()[0]!.body);
    // Before Marcus's claim the message would still say $11.00 unclaimed.
    expect(text).toMatch(/Every dish is claimed/);
    expect(text).not.toMatch(/unclaimed/);
  });

  it("edits again once the window has passed", async () => {
    const bill = await seedDraft("b1");
    await settle(editBillMessage(bill, env()));
    // D1's clock, not the faked timer, decides the window; move the lease
    // into the past the way real time would.
    await db.prepare("UPDATE bills SET edit_lease_until = 0 WHERE id = ?").bind("b1").run();

    await settle(editBillMessage(bill, env()));

    expect(channelEdits()).toHaveLength(2);
  });

  it("keeps each bill's edits separate", async () => {
    const one = await seedDraft("b1");
    const two = await seedDraft("b2", { messageId: "msg-two" });

    await settle(Promise.all([editBillMessage(one, env()), editBillMessage(two, env())]));

    expect(channelEdits("msg-old")).toHaveLength(1);
    expect(channelEdits("msg-two")).toHaveLength(1);
  });

  it("skips a bill whose message has not been posted yet", async () => {
    const bill = await seedDraft("b1", { messageId: null });

    await settle(editBillMessage(bill, env()));

    expect(calls).toHaveLength(0);
  });
});

describe("followUp and ephemeral", () => {
  it("posts a follow-up message through the interaction webhook", async () => {
    await followUp(TOKEN, { content: "hello" }, env());

    expect(calls).toEqual([
      { url: `${API}/webhooks/${APP_ID}/${TOKEN}`, method: "POST", auth: null, body: { content: "hello" } },
    ]);
  });

  it("builds an ephemeral reply", () => {
    expect(ephemeral("only you")).toEqual({ type: 4, data: { content: "only you", flags: EPHEMERAL } });
    const row = { type: 1, components: [] };
    expect(ephemeral("with a button", [row])).toEqual({
      type: 4,
      data: { content: "with a button", flags: EPHEMERAL, components: [row] },
    });
  });
});

describe("a bill with one person", () => {
  async function page(path: string, token: string, init: RequestInit = {}): Promise<Response> {
    const ctx = createExecutionContext();
    const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const response = await app.fetch(new Request(`https://aazhi.test${path}`, { ...init, headers }), env(), ctx);
    await settle(waitOnExecutionContext(ctx));
    return response;
  }

  it("goes from /split through Confirm and counts on Spent and Unique visits, not Hosted", async () => {
    anthropic = () =>
      toolUse(saigonToolInput({ items: [{ label: "Pho dac biet", price: "18.00", confidence: 0.95 }], tax: "2.00", printed_total: "20.00" }));
    await run(slashSplit());
    const { id } = (await db.prepare("SELECT id FROM bills").first<{ id: string }>())!;

    const opened = await run({
      id: "int-3",
      application_id: APP_ID,
      type: 3,
      token: TOKEN,
      version: 1,
      guild_id: "guild-1",
      channel_id: "chan-1",
      member: MEMBER,
      data: { custom_id: `open:${id}`, component_type: 2 },
    });
    const reply: any = await opened.json();
    const link = new URL(reply.data.components[0].components[0].url);
    const token = link.searchParams.get("t")!;

    const [item] = await getBillItems(db, id);
    const claimed = await page(`/b/${id}/claim`, token, {
      method: "POST",
      body: JSON.stringify({ itemId: item!.id, participantId: "gavin", claimed: true }),
    });
    expect(claimed.status).toBe(200);
    const { revision } = (await getBill(db, id))!;
    const confirmed = await page(`/b/${id}/confirm`, token, { method: "POST", body: JSON.stringify({ revision }) });
    expect(confirmed.status).toBe(200);

    expect((await getBill(db, id))!.status).toBe("confirmed");
    expect(await personSummary(db, "guild-1", "gavin")).toMatchObject({ outings: 1, spentCents: 2000, hosted: 0 });
    const { lists } = await serverBoards(db, "guild-1", Date.UTC(2026, 9, 30));
    expect(lists["spent:all"].map((r) => [r.id, r.value])).toEqual([["gavin", 2000]]);
    expect(lists["visits:all"].map((r) => [r.id, r.value])).toEqual([["gavin", 1]]);
    expect(lists["hosted:all"]).toEqual([]);
  });
});
