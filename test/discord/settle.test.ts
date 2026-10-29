import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { confirmBill, getBill, reopenBill } from "../../src/db/bills";
import { listSettlements, recordSettlement } from "../../src/db/settlements";
import { commands } from "../../src/discord/commands";
import { parseAmount } from "../../src/discord/handlers/settle";
import type { Env } from "../../src/env";
import { seedSaigon } from "../fixtures/seed";
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

function user(id: string) {
  return { id, username: `${id}_user`, global_name: null, discriminator: "0", avatar: null };
}

function member(id: string, nick: string) {
  return { user: user(id), nick, roles: [], joined_at: "2020-01-01T00:00:00.000Z", deaf: false, mute: false, flags: 0, permissions: "0" };
}

const GAVIN = member("gavin", "Gavin");
const MARCUS = member("marcus", "Marcus");
const ZOE = member("zoe", "Zoe");

function inGuild(who: unknown) {
  return { guild_id: "guild-1", channel_id: "chan-1", channel: { id: "chan-1", type: 0 }, member: who };
}

function tap(customId: string, who: unknown) {
  return {
    id: "int-1",
    application_id: APP_ID,
    type: 3,
    token: TOKEN,
    version: 1,
    ...inGuild(who),
    message: { id: "msg-1", channel_id: "chan-1" },
    data: { custom_id: customId, component_type: 2 },
  };
}

function pick(customId: string, values: string[], who: unknown) {
  return { ...tap(customId, who), data: { custom_id: customId, component_type: 3, values } };
}

function submit(customId: string, value: string, who: unknown) {
  return {
    id: "int-3",
    application_id: APP_ID,
    type: 5,
    token: TOKEN,
    version: 1,
    ...inGuild(who),
    data: {
      custom_id: customId,
      components: [{ type: 18, id: 1, component: { type: 4, id: 2, custom_id: "amount", value } }],
    },
  };
}

function ledgerCommand(where: "guild" | "dm", everywhere?: boolean, who = "gavin") {
  const place =
    where === "guild"
      ? inGuild(member(who, who))
      : { channel_id: "dm-1", channel: { id: "dm-1", type: 1 }, user: user(who) };
  return {
    id: "int-4",
    application_id: APP_ID,
    type: 2,
    token: TOKEN,
    version: 1,
    ...place,
    data: {
      id: "cmd-2",
      name: "ledger",
      type: 1,
      ...(everywhere === undefined ? {} : { options: [{ name: "everywhere", type: 5, value: everywhere }] }),
    },
  };
}

function messageEdits() {
  return calls.filter((c) => c.url.startsWith(`${API}/channels/`));
}

function components(data: any): any[] {
  return ((data.components ?? []) as any[]).flatMap((row) => row.components ?? [row.component]);
}

function customIds(data: any): string[] {
  return components(data).flatMap((c) => (c.custom_id ? [c.custom_id] : []));
}

async function confirmed(billId = BILL): Promise<void> {
  const bill = (await getBill(db, billId))!;
  expect(await confirmBill(db, billId, bill.revision, "gavin")).toMatchObject({ ok: true });
}

async function settledCents(who: string): Promise<number> {
  return (await listSettlements(db, BILL)).filter((s) => s.participant === who).reduce((sum, s) => sum + s.cents, 0);
}

function expectPrivate(reply: any) {
  expect(reply.type).toBe(4);
  expect(reply.data.flags).toBe(EPHEMERAL);
}

function expectOutLoud(reply: any) {
  expect(reply.type).toBe(4);
  expect(reply.data.flags ?? 0).toBe(0);
  expect(reply.data.allowed_mentions).toEqual({ parse: [] });
}

describe("the owe card", () => {
  it("carries I paid for diners and Undo a payment for the payer, inside Discord's row limits", async () => {
    await seedSaigon(db, BILL);

    // Confirm answers by redrawing the bill message as the owe card.
    const card = await run(tap(`confirm:${BILL}:${(await getBill(db, BILL))!.revision}`, GAVIN));

    expect(card.type).toBe(7);
    expect(customIds(card.data)).toEqual([
      `pay:${BILL}`,
      `paid:${BILL}`,
      `math:${BILL}`,
      `notmine:${BILL}`,
      `open:${BILL}`,
      `undo:${BILL}`,
      `reopen:${BILL}`,
      `delete:${BILL}`,
    ]);
    expect(components(card.data).find((c) => c.custom_id === `paid:${BILL}`).label).toBe("I paid");
    expect(components(card.data).find((c) => c.custom_id === `undo:${BILL}`).label).toBe("Undo a payment");
    expect(card.data.components.length).toBeLessThanOrEqual(5);
    for (const row of card.data.components) expect(row.components.length).toBeLessThanOrEqual(5);
  });
});

describe("I paid", () => {
  it("offers the whole remaining amount or part of it, privately", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await run(tap(`paid:${BILL}`, MARCUS));

    expectPrivate(reply);
    expect(reply.data.content).toContain("$44.46");
    expect(customIds(reply.data)).toEqual([`paidall:${BILL}:4446`, `paidpart:${BILL}`]);
    expect(components(reply.data)[0].label).toContain("$44.46");
  });

  it("offers only what is left after a partial payment", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 4000, "marcus");

    const reply = await run(tap(`paid:${BILL}`, MARCUS));

    expect(reply.data.content).toContain("$4.46");
    expect(customIds(reply.data)).toEqual([`paidall:${BILL}:446`, `paidpart:${BILL}`]);
  });

  it("records paying it all and says so in the channel without touching the owe card", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await run(tap(`paidall:${BILL}:4446`, MARCUS));

    expectOutLoud(reply);
    expect(reply.data.content).toMatch(/Marcus paid Gavin \$44\.46/);
    expect(reply.data.content).toMatch(/paid up/i);
    expect(await settledCents("marcus")).toBe(4446);
    expect(messageEdits()).toEqual([]);
  });

  it("refuses a stale paid-it-all and says what is left now", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 4000, "marcus");

    const reply = await run(tap(`paidall:${BILL}:4446`, MARCUS));

    expectPrivate(reply);
    expect(reply.data.content).toContain("$4.46");
    expect(await settledCents("marcus")).toBe(4000);
  });

  it("says the person is already paid up when they tap paid-it-all twice", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await run(tap(`paidall:${BILL}:4446`, MARCUS));

    const again = await run(tap(`paidall:${BILL}:4446`, MARCUS));
    const paid = await run(tap(`paid:${BILL}`, MARCUS));

    for (const reply of [again, paid]) {
      expectPrivate(reply);
      expect(reply.data.content).toMatch(/paid up/i);
      expect(customIds(reply.data)).toEqual([]);
    }
    expect(await settledCents("marcus")).toBe(4446);
  });

  it("tells the payer there is nothing for them to record", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await run(tap(`paid:${BILL}`, GAVIN));
    const all = await run(tap(`paidall:${BILL}:4833`, GAVIN));

    for (const r of [reply, all]) {
      expectPrivate(r);
      expect(r.data.content).toMatch(/you paid the bill/i);
    }
    expect(await listSettlements(db, BILL)).toEqual([]);
  });

  it("tells someone who is not on the bill there is nothing for them", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    for (const id of [`paid:${BILL}`, `paidall:${BILL}:4446`, `paidpart:${BILL}`]) {
      const reply = await run(tap(id, ZOE));
      expectPrivate(reply);
      expect(reply.data.content).toMatch(/not on this bill/i);
    }
    expect(await listSettlements(db, BILL)).toEqual([]);
  });

  it("says paying is paused on a reopened bill and records nothing", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await reopenBill(db, BILL);

    for (const body of [tap(`paid:${BILL}`, MARCUS), tap(`paidall:${BILL}:4446`, MARCUS), submit(`paidamount:${BILL}`, "10", MARCUS)]) {
      const reply = await run(body);
      expectPrivate(reply);
      expect(reply.data.content).toMatch(/paused/i);
    }
    expect(await listSettlements(db, BILL)).toEqual([]);
  });
});

describe("Paid part", () => {
  it("opens a modal asking for the amount", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await run(tap(`paidpart:${BILL}`, MARCUS));

    expect(reply.type).toBe(9);
    expect(reply.data.custom_id).toBe(`paidamount:${BILL}`);
    const [input] = components(reply.data).filter((c) => c.type === 4);
    expect(input).toMatchObject({ custom_id: "amount", required: true });
  });

  it("records the amount typed and says what is left", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await run(submit(`paidamount:${BILL}`, "40", MARCUS));

    expectOutLoud(reply);
    expect(reply.data.content).toMatch(/Marcus paid Gavin \$40\.00/);
    expect(reply.data.content).toContain("$4.46 left");
    expect(await settledCents("marcus")).toBe(4000);
  });

  // The same signed submit arriving twice (a retry, or a captured request
  // replayed) is one payment, not two, and the second gets the first's answer.
  it("records a replayed submit once and answers it as the original", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    const body = submit(`paidamount:${BILL}`, "10", MARCUS);

    const first = await run(body);
    const again = await run(body);

    expectOutLoud(first);
    expect(first.data.content).toMatch(/Marcus paid Gavin \$10\.00/);
    expect(again).toEqual(first);
    expect((await listSettlements(db, BILL)).map((s) => [s.id, s.cents])).toEqual([[body.id, 1000]]);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);

    // A second, real payment of the same amount is its own interaction.
    const next = await run({ ...submit(`paidamount:${BILL}`, "10", MARCUS), id: "int-5" });
    expectOutLoud(next);
    expect(await settledCents("marcus")).toBe(2000);
  });

  it("answers a replayed submit that paid everything as the original, not as already paid up", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    const body = submit(`paidamount:${BILL}`, "44.46", MARCUS);

    const first = await run(body);
    const again = await run(body);

    expectOutLoud(first);
    expect(first.data.content).toMatch(/paid up/i);
    expect(again).toEqual(first);
    expect(await settledCents("marcus")).toBe(4446);
    expect(await listSettlements(db, BILL)).toHaveLength(1);
  });

  it("refuses an amount that is not money, has too many decimals, is not positive or is more than is left", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    for (const typed of ["abc", "12.345", "1,000", "", "0", "-5", "44.47", "4e3", "0x10"]) {
      const reply = await run(submit(`paidamount:${BILL}`, typed, MARCUS));
      expectPrivate(reply);
      expect(reply.data.content.length, typed).toBeGreaterThan(0);
    }
    const over = await run(submit(`paidamount:${BILL}`, "44.47", MARCUS));
    expect(over.data.content).toContain("$44.46");
    expect(await listSettlements(db, BILL)).toEqual([]);
  });
});

describe("parseAmount", () => {
  it("reads a typed amount as integer cents by string parsing", () => {
    expect(parseAmount("40")).toBe(4000);
    expect(parseAmount(" $40.5 ")).toBe(4050);
    expect(parseAmount("0.07")).toBe(7);
    expect(parseAmount("44.46")).toBe(4446);
  });

  it("rejects anything that is not a plain amount with at most two decimals", () => {
    for (const typed of ["abc", "12.345", "1,000", "", " ", "4e3", "0x10", "$", "1.", ".5", "1 000", "$$5", "NaN", "Infinity"]) {
      expect(parseAmount(typed), typed).toBeNull();
    }
  });
});

describe("Pay my share", () => {
  it("asks for what is left after a partial payment, in the link too", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 4000, "marcus");
    await db
      .prepare("INSERT INTO payment_handles (user_id, method, handle, updated_at) VALUES ('gavin', 'venmo', 'gavin-lin', '2026-10-28')")
      .run();

    const reply = await run(tap(`pay:${BILL}`, MARCUS));

    expectPrivate(reply);
    expect(reply.data.content).toContain("$4.46");
    expect(reply.data.content).toContain("$40.00");
    const [venmo] = components(reply.data).filter((c) => c.style === 5);
    expect(new URL(venmo.url).searchParams.get("amount")).toBe("4.46");
  });

  it("says the person is paid up when nothing is left", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 4446, "marcus");

    const reply = await run(tap(`pay:${BILL}`, MARCUS));

    expectPrivate(reply);
    expect(reply.data.content).toMatch(/paid up/i);
    expect(components(reply.data)).toEqual([]);
  });
});

describe("Undo a payment", () => {
  it("lists the bill's payments for the payer and removes the one picked, out loud", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 4000, "marcus");
    await recordSettlement(db, BILL, "jess", 4382, "jess");
    const marcusPayment = (await listSettlements(db, BILL)).find((s) => s.participant === "marcus")!;

    const menu = await run(tap(`undo:${BILL}`, GAVIN));

    expectPrivate(menu);
    const [select] = components(menu.data);
    expect(select.type).toBe(3);
    expect(select.custom_id).toBe(`undopick:${BILL}`);
    const option = select.options.find((o: any) => o.value === marcusPayment.id);
    expect(option.label).toContain("Marcus");
    expect(option.label).toContain("$40.00");
    expect(select.options).toHaveLength(2);

    const reply = await run(pick(`undopick:${BILL}`, [marcusPayment.id], GAVIN));

    expectOutLoud(reply);
    expect(reply.data.content).toMatch(/Gavin removed Marcus's \$40\.00 payment/);
    expect(reply.data.content).toContain("$44.46 left");
    expect(await settledCents("marcus")).toBe(0);
    expect(await settledCents("jess")).toBe(4382);
    expect(messageEdits()).toEqual([]);

    const twice = await run(pick(`undopick:${BILL}`, [marcusPayment.id], GAVIN));
    expectPrivate(twice);
    expect(await settledCents("jess")).toBe(4382);
  });

  it("refuses anyone but the payer, from the button or the menu", async () => {
    await seedSaigon(db, BILL);
    await confirmed();
    await recordSettlement(db, BILL, "marcus", 4000, "marcus");
    const [payment] = await listSettlements(db, BILL);

    const menu = await run(tap(`undo:${BILL}`, MARCUS));
    const picked = await run(pick(`undopick:${BILL}`, [payment!.id], MARCUS));

    for (const reply of [menu, picked]) {
      expectPrivate(reply);
      expect(reply.data.content).toMatch(/Only Gavin/);
      expect(customIds(reply.data)).toEqual([]);
    }
    expect(await settledCents("marcus")).toBe(4000);
  });

  it("refuses a payment from another bill", async () => {
    await seedSaigon(db, BILL);
    await seedSaigon(db, "bill-2", { bill: { channelId: "chan-2", messageId: "msg-2" } });
    await confirmed();
    await confirmed("bill-2");
    await recordSettlement(db, "bill-2", "marcus", 4000, "marcus");
    const [other] = await listSettlements(db, "bill-2");

    const reply = await run(pick(`undopick:${BILL}`, [other!.id], GAVIN));

    expectPrivate(reply);
    expect(await listSettlements(db, "bill-2")).toHaveLength(1);
  });

  it("says when nobody has recorded a payment yet", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await run(tap(`undo:${BILL}`, GAVIN));

    expectPrivate(reply);
    expect(reply.data.content).toMatch(/nobody has recorded/i);
    expect(customIds(reply.data)).toEqual([]);
  });
});

describe("/ledger", () => {
  it("is registered with an optional everywhere switch and works in DMs too", () => {
    const command = commands.find((c) => c.name === "ledger") as any;

    expect(command).toBeDefined();
    expect(command.options.map((o: any) => [o.name, o.type, o.required ?? false])).toEqual([["everywhere", 5, false]]);
    expect(command.contexts).toEqual(expect.arrayContaining([0, 1]));
  });

  async function twoServers() {
    await seedSaigon(db, BILL);
    await seedSaigon(db, "bill-2", { bill: { guildId: "guild-2", channelId: "chan-2", messageId: "msg-2" } });
    await confirmed();
    await confirmed("bill-2");
    await recordSettlement(db, BILL, "marcus", 4000, "marcus");
  }

  it("shows the payer who still owes them in this server, privately, with a total", async () => {
    await twoServers();

    const reply = await run(ledgerCommand("guild"));

    expectPrivate(reply);
    const lines = reply.data.content.split("\n");
    expect(lines[0]).toMatch(/this server/i);
    expect(lines.find((l: string) => l.includes("Marcus"))).toMatch(/\$4\.46[^\n]*1 bill\b/);
    expect(lines.find((l: string) => l.includes("Priya"))).toMatch(/\$50\.91/);
    expect(reply.data.content).not.toContain("Gavin");
    // 275.79 owed on the bill by everyone but Gavin, less Marcus's 40.00.
    expect(lines.at(-1)).toContain("Total: $235.79");
  });

  it("rolls up every server with everywhere, and outside a server", async () => {
    await twoServers();

    for (const body of [ledgerCommand("guild", true), ledgerCommand("dm")]) {
      const reply = await run(body);
      expectPrivate(reply);
      expect(reply.data.content).toMatch(/every server/i);
      expect(reply.data.content.split("\n").find((l: string) => l.includes("Marcus"))).toMatch(/\$48\.92[^\n]*2 bills/);
      expect(reply.data.content.split("\n").at(-1)).toContain("Total: $511.58");
    }
  });

  it("says nobody owes them when every share is paid", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await run(ledgerCommand("guild", false, "marcus"));

    expectPrivate(reply);
    expect(reply.data.content).toMatch(/nobody owes you/i);
    expect(reply.data.content).toContain("everywhere");
  });
});
