import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { confirmBill, getBill, getShares, type BillRow, type Participant } from "../../src/db/bills";
import { getPaymentHandles } from "../../src/db/handles";
import { commands } from "../../src/discord/commands";
import { renderMath } from "../../src/discord/handlers/owe";
import { renderBill } from "../../src/discord/render";
import type { Env } from "../../src/env";
import { formatCents } from "../../src/format";
import { splitBill } from "../../src/money/split";
import type { BillInput } from "../../src/money/types";
import { SAIGON } from "../fixtures/saigon";
import { SAIGON_NAMES, seedSaigon } from "../fixtures/seed";
import { generateKeypair, signedRequest, testEnv, type TestKeypair } from "./helpers";

const db = workerEnv.DB;
const BILL = "bill-1";
const API = "https://discord.com/api/v10";
const APP_ID = "app-1";
const TOKEN = "interaction-token";
const EPHEMERAL = 1 << 6;

let keypair: TestKeypair;
const ready = generateKeypair().then((k) => (keypair = k));

function env(): Env {
  return { ...testEnv(keypair.publicKeyHex), DISCORD_BOT_TOKEN: "bot-token", DISCORD_APPLICATION_ID: APP_ID, TOKEN_SIGNING_KEY: "k" };
}

let calls: { url: string; method: string; body: any }[];

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
  await db.prepare("DELETE FROM payment_handles").run();
  calls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const channel = /\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(url);
    return Response.json(channel ? { id: channel[2], channel_id: channel[1] } : { id: "follow-up-1", channel_id: "chan-1" });
  });
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
const MARCUS = member("marcus", "Marcus");
const ZOE = member("zoe", "Zoe");

function tap(customId: string, who: unknown) {
  return {
    id: "int-1",
    application_id: APP_ID,
    type: 3,
    token: TOKEN,
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    channel: { id: "chan-1", type: 0 },
    member: who,
    message: { id: "msg-1", channel_id: "chan-1" },
    data: { custom_id: customId, component_type: 2 },
  };
}

function paywith(method: string, handle: string, who: unknown) {
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
      options: [
        { name: "method", type: 3, value: method },
        { name: "handle", type: 3, value: handle },
      ],
    },
  };
}

function messageEdits(channelId = "chan-1", messageId = "msg-1") {
  return calls.filter((c) => c.url === `${API}/channels/${channelId}/messages/${messageId}`);
}

function components(data: any): any[] {
  return ((data.components ?? []) as any[]).flatMap((row) => row.components);
}

function customIds(data: any): string[] {
  return components(data).flatMap((c) => (c.custom_id ? [c.custom_id] : []));
}

function linkUrls(data: any): URL[] {
  return components(data)
    .filter((c) => c.style === 5)
    .map((c) => new URL(c.url));
}

function shown(data: any): string {
  return [data.content ?? "", ...(data.embeds ?? []).map((e: any) => JSON.stringify(e))].join("\n");
}

function centsIn(amount: string): number {
  expect(amount).toMatch(/^\d+\.\d{2}$/);
  return Number(amount.replace(".", ""));
}

async function confirmed(billId = BILL): Promise<void> {
  const bill = (await getBill(db, billId))!;
  expect(await confirmBill(db, billId, bill.revision, "gavin")).toMatchObject({ ok: true });
}

async function pay(who: string, cents: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO settlements (id, bill_id, participant_id, cents, recorded_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), BILL, who, cents, "2026-10-29T09:00:00.000Z", who)
    .run();
}

const bill: BillRow = {
  id: BILL,
  guildId: "guild-1",
  channelId: "chan-1",
  messageId: "msg-1",
  payerId: "gavin",
  place: "Saigon Kitchen",
  billDate: "2026-10-28",
  taxCents: 2232,
  tipCents: 5030,
  printedTotalCents: 27382,
  status: "confirmed",
  revision: 9,
  createdAt: "2026-10-28T20:00:00.000Z",
  confirmedAt: "2026-10-28T22:00:00.000Z",
};

function participantsOf(input: BillInput): Participant[] {
  return input.participants.map((id) => ({ billId: BILL, id, kind: "member", displayName: SAIGON_NAMES[id] ?? id, addedBy: null }));
}

const shares = splitBill(SAIGON).shares;
const marcusShare = shares.find((s) => s.participant === "marcus")!;
const items = SAIGON.items;

describe("the owe card", () => {
  it("renders frozen amounts and pay controls once confirmed", () => {
    const data = renderBill(bill, splitBill(SAIGON), items, participantsOf(SAIGON), [], shares);
    const text = shown(data);

    expect(text).toContain("$44.46");
    const marcusRow = (data.embeds![0]!.description ?? "").split("\n").find((l) => l.includes("<@marcus>"))!;
    // Just the amount: what it covers is in Show my math and on the page.
    expect(marcusRow).toBe("<@marcus> · $44.46");
    expect(text).toMatch(/pay <@gavin>/i);

    const labels = components(data).map((c) => c.label);
    expect(labels).toContain("Pay my share");
    expect(labels).toContain("Show my math");
    expect(labels).toContain("That's not mine");
    expect(customIds(data)).toEqual([
      `pay:${BILL}`,
      `paid:${BILL}`,
      `math:${BILL}`,
      `notmine:${BILL}`,
      `open:${BILL}`,
      `undo:${BILL}`,
      `reopen:${BILL}`,
      `delete:${BILL}`,
    ]);
    // Discord caps a row at five buttons.
    for (const row of data.components as any[]) expect(row.components.length).toBeLessThanOrEqual(5);
    expect(data.allowed_mentions).toEqual({ parse: [] });
  });

  it("offers no pay control on a draft", () => {
    const draft = renderBill({ ...bill, status: "draft" }, splitBill(SAIGON), items, participantsOf(SAIGON));
    expect(customIds(draft).some((id) => /^(pay|math|notmine):/.test(id))).toBe(false);
  });
});

describe("renderMath", () => {
  it("shows a person's math adding exactly to their total", () => {
    const text = renderMath(marcusShare, items, bill);
    expect(text).toContain("$34.50");
    expect(text).toContain("$3.06");
    expect(text).toContain("$6.90");
    expect(text).toContain("$44.46");
  });

  it("lists the person's items with their piece of each shared one", () => {
    const text = renderMath(marcusShare, items, bill);

    expect(text).toMatch(/Spring rolls[^\n]*\$15\.00[^\n]*3[^\n]*\$5\.00/);
    expect(text).toMatch(/Thai iced tea x3[^\n]*\$15\.00[^\n]*3[^\n]*\$5\.00/);
    expect(text).toMatch(/Bun bo Hue[^\n]*\$24\.50/);
    expect(text).not.toContain("Shaking beef");
  });

  it("gives the fraction as cents over the bill subtotal, never as a float percentage", () => {
    const text = renderMath(marcusShare, items, bill);

    expect(text).toContain("3450/25150");
    expect(text).toContain("$251.50");
    expect(text).not.toMatch(/%|13\.7|0\.137/);
  });

  it("adds up to the frozen amount for every diner, including a split with a stray cent", () => {
    for (const share of shares) {
      const text = renderMath(share, items, bill);
      expect(text).toContain(formatCents(share.subtotalCents));
      expect(text).toContain(`${share.subtotalCents}/25150`);
      expect(text).toContain(formatCents(share.owedCents));
      expect(share.subtotalCents + share.taxCents + share.tipCents).toBe(share.owedCents);
    }

    // $10.00 three ways: the stray cent goes to the first id, so ana's piece is
    // $3.34 and the others $3.33.
    const odd: BillInput = {
      items: [{ id: "x", label: "Shared plate", cents: 1000, claimedBy: ["cy", "ana", "bo"] }],
      taxCents: 100,
      tipCents: 0,
      payer: "ana",
      participants: ["ana", "bo", "cy"],
      pardoned: [],
    };
    const result = splitBill(odd);
    const ana = result.shares.find((s) => s.participant === "ana")!;
    const bo = result.shares.find((s) => s.participant === "bo")!;
    const oddBill = { ...bill, taxCents: 100, tipCents: 0 };
    expect(renderMath(ana, odd.items, oddBill)).toMatch(/Shared plate[^\n]*\$3\.34/);
    expect(renderMath(bo, odd.items, oddBill)).toMatch(/Shared plate[^\n]*\$3\.33/);
    expect(renderMath(ana, odd.items, oddBill)).toContain(formatCents(ana.owedCents));
  });
});

// The amounts on each item line of a math reply (the last amount on the line),
// read back as integer cents, plus the folded "more lines" row.
function itemLineCents(text: string): number[] {
  const lines = text.split("\n");
  const end = lines.findIndex((l) => l.startsWith("Your items:"));
  return lines.slice(1, end).map((l) => {
    const amount = l.match(/\$[\d,]+\.\d{2}/g)!.at(-1)!;
    return Number(amount.replace(/[$,.]/g, ""));
  });
}

describe("renderMath inside Discord's limits", () => {
  it("stays under 2000 characters with many long shared labels full of markdown, and still adds up", () => {
    const people = ["ana", "bo", "cy"];
    const label = "**_Chef's_** `special` ~~platter~~ ||with|| [extra] #sauce > ".repeat(3);
    const odd: BillInput = {
      items: Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, label: `${i} ${label}`, cents: 1000 + i, claimedBy: people })),
      taxCents: 2232,
      tipCents: 5030,
      payer: "ana",
      participants: people,
      pardoned: [],
    };
    const result = splitBill(odd);
    const longBill = { ...bill, place: "*_The Very Long Restaurant Name_* ".repeat(20), taxCents: 2232, tipCents: 5030 };

    for (const share of result.shares) {
      const text = renderMath(share, odd.items, longBill);
      expect(text.length).toBeLessThanOrEqual(2000);
      expect(text).toMatch(/\d+ more lines: \$/);
      expect(itemLineCents(text).reduce((a, b) => a + b, 0)).toBe(share.subtotalCents);
      expect(text).toContain(`= ${formatCents(share.owedCents)}**`);
      expect(share.subtotalCents + share.taxCents + share.tipCents).toBe(share.owedCents);
    }
  });

  it("lists every line and folds nothing when the person's lines fit", () => {
    const text = renderMath(marcusShare, items, bill);
    expect(text).not.toMatch(/more lines/);
    expect(itemLineCents(text)).toEqual([500, 500, 2450]);
  });

  it("marks the rounded tax and tip slices as approximate and the closing sum as exact", () => {
    const text = renderMath(marcusShare, items, bill);
    expect(text).toContain("Tax: $22.32 × 3450/25150 ≈ $3.06");
    expect(text).toContain("Tip: $50.30 × 3450/25150 ≈ $6.90");
    expect(text).toContain("$34.50 + $3.06 + $6.90 = $44.46");
  });
});

describe("Pay my share", () => {
  it("keeps every pay link inside Discord's limit for a long CJK place name", async () => {
    const place = "西贡厨房越南河粉专门店".repeat(10);
    await seedSaigon(db, BILL, { bill: { place } });
    await confirmed();
    await run(paywith("venmo", "a".repeat(30), GAVIN));
    await run(paywith("cashapp", "GavinL", GAVIN));
    await run(paywith("zelle", "gavin@example.com", GAVIN));

    const reply = await run(tap(`pay:${BILL}`, MARCUS));

    expect(reply.type).toBe(4);
    const urls = linkUrls(reply.data);
    expect(urls).toHaveLength(2);
    for (const url of urls) expect(url.href.length).toBeLessThanOrEqual(512);
    expect(urls[0]!.searchParams.get("amount")).toBe("44.46");
    expect(place.startsWith(urls[0]!.searchParams.get("note")!.replace(/…$/, ""))).toBe(true);
    expect(reply.data.content.length).toBeLessThanOrEqual(2000);
  });

  it("gives a Zelle-only payer's diners instructions and no buttons", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await run(paywith("zelle", "(555) 123-4567", GAVIN));

    const reply = await run(tap(`pay:${BILL}`, MARCUS));

    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.components ?? []).toEqual([]);
    expect(reply.data.content).toContain("$44.46");
    expect(reply.data.content).toMatch(/Zelle[^\n]*\(555\) 123-4567/);
    expect(reply.data.content).toContain("Saigon Kitchen");
    expect(reply.data.content).not.toMatch(/buttons below/i);
  });

  it("prefills a Venmo link with the amount and note from the payer's handle", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await run(paywith("venmo", "@gavin-lin", GAVIN));

    const reply = await run(tap(`pay:${BILL}`, MARCUS));

    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toContain("$44.46");
    const [venmo] = linkUrls(reply.data);
    expect(venmo!.origin).toBe("https://venmo.com");
    expect(venmo!.pathname).toBe("/gavin-lin");
    expect(venmo!.searchParams.get("amount")).toBe("44.46");
    expect(venmo!.searchParams.get("note")).toContain("Saigon Kitchen");
  });

  it("lists every method the payer has on file, with Zelle as instructions", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await run(paywith("zelle", "gavin@example.com", GAVIN));
    await run(paywith("cashapp", "$GavinL", GAVIN));
    await run(paywith("venmo", "gavin-lin", GAVIN));

    const reply = await run(tap(`pay:${BILL}`, MARCUS));

    const urls = linkUrls(reply.data);
    expect(urls.map((u) => u.origin)).toEqual(["https://venmo.com", "https://cash.app"]);
    expect(urls[1]!.pathname).toBe("/$GavinL/44.46");
    expect(reply.data.content).toMatch(/Zelle[^\n]*gavin@example\.com/);
    expect(reply.data.content).toMatch(/Cash App[^\n]*note/i);
  });

  it("asks the payer to set a handle instead of rendering a dead link", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await run(tap(`pay:${BILL}`, MARCUS));

    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toContain("$44.46");
    expect(reply.data.content).toMatch(/Gavin hasn't set/i);
    expect(reply.data.content).toContain("/paywith");
    expect(linkUrls(reply.data)).toEqual([]);
    expect(reply.data.components ?? []).toEqual([]);
  });

  it("reuses a handle set on an earlier bill", async () => {
    await run(paywith("venmo", "gavin-lin", GAVIN));
    await seedSaigon(db, BILL);
    await confirmed();
    const first = await run(tap(`pay:${BILL}`, MARCUS));

    await seedSaigon(db, "bill-2", { bill: { channelId: "chan-2", messageId: "msg-2" } });
    await confirmed("bill-2");
    const second = await run(tap(`pay:bill-2`, MARCUS));

    expect(linkUrls(first.data)[0]!.pathname).toBe("/gavin-lin");
    expect(linkUrls(second.data)[0]!.pathname).toBe("/gavin-lin");
    expect(linkUrls(second.data)[0]!.searchParams.get("amount")).toBe("44.46");
  });

  it("gives every diner a link for exactly their frozen amount", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await run(paywith("venmo", "gavin-lin", GAVIN));
    await run(paywith("cashapp", "GavinL", GAVIN));
    const frozen = await getShares(db, BILL);

    for (const share of frozen.filter((s) => s.participant !== "gavin")) {
      const reply = await run(tap(`pay:${BILL}`, member(share.participant, SAIGON_NAMES[share.participant]!)));
      const [venmo, cash] = linkUrls(reply.data);
      expect(centsIn(venmo!.searchParams.get("amount")!), share.participant).toBe(share.owedCents);
      expect(centsIn(cash!.pathname.split("/").at(-1)!), share.participant).toBe(share.owedCents);
      expect(reply.data.content).toContain(formatCents(share.owedCents));
    }
  });

  it("tells the payer they paid, and how to let people pay them by link", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await run(tap(`pay:${BILL}`, GAVIN));

    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toMatch(/you paid/i);
    expect(reply.data.content).toContain("/paywith");
    expect(linkUrls(reply.data)).toEqual([]);
  });

  it("tells someone who is not on the bill that there is nothing for them", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await run(paywith("venmo", "gavin-lin", GAVIN));

    const payReply = await run(tap(`pay:${BILL}`, ZOE));
    const mathReply = await run(tap(`math:${BILL}`, ZOE));

    for (const reply of [payReply, mathReply]) {
      expect(reply.data.flags).toBe(EPHEMERAL);
      expect(reply.data.content).toMatch(/not on this bill/i);
      expect(linkUrls(reply.data)).toEqual([]);
      expect(reply.data.content).not.toContain("$");
    }
  });

  it("asks for nothing when the payer waived the share", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await run(paywith("venmo", "gavin-lin", GAVIN));
    await db.prepare("UPDATE shares SET pardoned = 1 WHERE bill_id = ? AND participant_id = 'marcus'").bind(BILL).run();

    const reply = await run(tap(`pay:${BILL}`, MARCUS));

    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toMatch(/Gavin covered your share/);
    expect(linkUrls(reply.data)).toEqual([]);
  });

  it("says paying is paused on a bill that was reopened", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await run(paywith("venmo", "gavin-lin", GAVIN));
    await run(tap(`notmine:${BILL}`, MARCUS));

    const reply = await run(tap(`pay:${BILL}`, MARCUS));

    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toMatch(/paused/i);
    expect(linkUrls(reply.data)).toEqual([]);
  });
});

describe("Show my math", () => {
  it("answers the tapper privately with their own math", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await run(tap(`math:${BILL}`, MARCUS));

    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBe(EPHEMERAL);
    for (const amount of ["$34.50", "$3.06", "$6.90", "$44.46"]) expect(reply.data.content).toContain(amount);
    expect(reply.data.content).toContain("3450/25150");
  });
});

describe("That's not mine", () => {
  it("darkens pay controls for everyone when one person objects", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    await run(tap(`notmine:${BILL}`, MARCUS));

    expect((await getBill(db, BILL))!.status).toBe("draft");
    expect(messageEdits()).toHaveLength(1);
    const card = messageEdits()[0]!.body;
    expect(customIds(card).some((id) => /^(pay|math|notmine):/.test(id))).toBe(false);
    expect(customIds(card)).toContain(`open:${BILL}`);
  });

  it("names who objected in the channel", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await run(tap(`notmine:${BILL}`, MARCUS));

    expect(reply.type).toBe(4);
    expect(reply.data.flags ?? 0).toBe(0);
    expect(reply.data.content).toMatch(/Marcus/);
    expect(reply.data.content).toMatch(/paused/i);
    expect(reply.data.content).toMatch(/Gavin/);
    expect(reply.data.allowed_mentions).toEqual({ parse: [] });
  });

  it("says out loud how the amounts moved for anyone who already paid", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await pay("marcus", 4446);
    // The misread spring rolls, corrected behind the frozen bill's back the way
    // the T8 tests model it.
    await db.prepare("UPDATE bill_items SET cents = 642 WHERE id = ?").bind(`${BILL}-rolls`).run();

    const reply = await run(tap(`notmine:${BILL}`, MARCUS));

    expect(reply.data.content).toContain("Marcus paid $44.46 and now owes $41.10, so Gavin owes Marcus $3.36.");
  });

  it("lets the payer flag it too, and names them", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await run(tap(`notmine:${BILL}`, GAVIN));

    expect(reply.type).toBe(4);
    expect(reply.data.flags ?? 0).toBe(0);
    expect(reply.data.content).toMatch(/^Gavin flagged/);
    expect(reply.data.content).toMatch(/paused/i);
    expect((await getBill(db, BILL))!.status).toBe("draft");
    expect(customIds(messageEdits()[0]!.body).some((id) => /^(pay|math|notmine):/.test(id))).toBe(false);
  });

  it("refuses someone who is not on the bill and leaves it confirmed", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await run(tap(`notmine:${BILL}`, ZOE));

    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toMatch(/not on this bill/i);
    expect((await getBill(db, BILL))!.status).toBe("confirmed");
    expect(messageEdits()).toEqual([]);
  });
});

describe("/paywith", () => {
  it("is registered with a method choice and a handle", () => {
    const command = commands.find((c) => c.name === "paywith") as any;

    expect(command).toBeDefined();
    expect(command.options.map((o: any) => [o.name, o.required])).toEqual([
      ["method", true],
      ["handle", true],
    ]);
    expect(command.options[0].choices.map((c: any) => c.value)).toEqual(["venmo", "cashapp", "zelle"]);
  });

  it("saves a handle, replaces it on a second run, and answers privately", async () => {
    const first = await run(paywith("venmo", "@gavin-lin", GAVIN));
    await run(paywith("venmo", "gavin-l2", GAVIN));

    expect(first.type).toBe(4);
    expect(first.data.flags).toBe(EPHEMERAL);
    expect(first.data.content).toContain("@gavin-lin");
    expect(await getPaymentHandles(db, "gavin")).toEqual([{ method: "venmo", handle: "gavin-l2" }]);
  });

  it("rejects a handle that is not valid for the method and stores nothing", async () => {
    const reply = await run(paywith("venmo", "evil.example/x?txn=charge", GAVIN));
    const zelle = await run(paywith("zelle", "not an email", GAVIN));

    expect(reply.data.flags).toBe(EPHEMERAL);
    expect(reply.data.content).toMatch(/venmo/i);
    expect(zelle.data.content).toMatch(/zelle/i);
    expect(await getPaymentHandles(db, "gavin")).toEqual([]);
  });
});
