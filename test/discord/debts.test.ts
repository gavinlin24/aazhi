import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { confirmBill, getBill, reopenBill } from "../../src/db/bills";
import { recordSettlement, type BillDebt } from "../../src/db/settlements";
import { commands } from "../../src/discord/commands";
import { renderDebts } from "../../src/discord/handlers/debts";
import type { Env } from "../../src/env";
import { readToken } from "../../src/web/token";
import { seedSaigon } from "../fixtures/seed";
import { generateKeypair, signedRequest, testEnv, type TestKeypair } from "./helpers";

const db = workerEnv.DB;
const BILL = "bill-1";
const APP_ID = "app-1";
const TOKEN = "interaction-token";
const EPHEMERAL = 1 << 6;

let keypair: TestKeypair;
const ready = generateKeypair().then((k) => (keypair = k));

function env(): Env {
  return { ...testEnv(keypair.publicKeyHex), DISCORD_BOT_TOKEN: "bot-token", DISCORD_APPLICATION_ID: APP_ID, TOKEN_SIGNING_KEY: "k" };
}

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
  vi.stubGlobal("fetch", async () => Response.json({ id: "follow-up-1", channel_id: "chan-1" }));
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

function inGuild(who: unknown) {
  return { guild_id: "guild-1", channel_id: "chan-1", channel: { id: "chan-1", type: 0 }, member: who };
}

function debtsCommand(where: "guild" | "dm", everywhere?: boolean, who = "gavin") {
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
      name: "debts",
      type: 1,
      ...(everywhere === undefined ? {} : { options: [{ name: "everywhere", type: 5, value: everywhere }] }),
    },
  };
}

async function confirmed(billId = BILL): Promise<void> {
  const bill = (await getBill(db, billId))!;
  expect(await confirmBill(db, billId, bill.revision, "gavin")).toMatchObject({ ok: true });
}

function expectPrivate(reply: any) {
  expect(reply.type).toBe(4);
  expect(reply.data.flags).toBe(EPHEMERAL);
}

function debt(billId: string, debtor: string, cents: number, over: Partial<BillDebt> = {}): BillDebt {
  return {
    billId,
    place: "Saigon Kitchen",
    date: "2026-10-28",
    payer: "gavin",
    payerName: "Gavin",
    debtor,
    debtorName: debtor,
    debtorKind: "member",
    owedCents: cents,
    settledCents: 0,
    ...over,
  };
}

function dollars(text: string): number {
  return Math.round(Number(text.replace(/[$,]/g, "")) * 100);
}

describe("/debts", () => {
  it("is registered with an optional everywhere switch and works in DMs too", () => {
    const command = commands.find((c) => c.name === "debts") as any;

    expect(command).toBeDefined();
    expect(commands.find((c) => c.name === "ledger")).toBeUndefined();
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

  it("shows the payer what they're owed in this server, privately, one line per bill", async () => {
    await twoServers();

    const reply = await run(debtsCommand("guild"));

    expectPrivate(reply);
    const lines = reply.data.content.split("\n");
    // 275.79 owed on the bill by everyone but Gavin, less Marcus's 40.00.
    expect(lines[0]).toBe("**You're owed $235.79 in this server**");
    const at = lines.indexOf("Marcus: $4.46");
    expect(lines[at + 1]).toBe("- Saigon Kitchen, Oct 28, 2026: $4.46");
    expect(lines).toContain("Priya: $50.91");
    expect(reply.data.content).not.toContain("Gavin");
    expect(reply.data.content).not.toContain("You owe");
  });

  it("rolls up every server with everywhere, and outside a server", async () => {
    await twoServers();

    for (const body of [debtsCommand("guild", true), debtsCommand("dm")]) {
      const reply = await run(body);
      expectPrivate(reply);
      const lines = reply.data.content.split("\n");
      expect(lines[0]).toBe("**You're owed $511.58 across every server**");
      const at = lines.indexOf("Marcus: $48.92");
      expect(lines.slice(at + 1, at + 3).every((l: string) => l.startsWith("- Saigon Kitchen"))).toBe(true);
    }
  });

  it("shows what they owe with a link that opens that bill as them", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    const reply = await run(debtsCommand("guild", false, "marcus"));

    expectPrivate(reply);
    const lines = reply.data.content.split("\n");
    expect(lines.slice(0, 2)).toEqual(["**You owe $44.46 in this server**", "Gavin: $44.46"]);
    const link = /^- \[Saigon Kitchen, Oct 28, 2026\]\(<(.+)>\): \$44\.46$/.exec(lines[2]);
    expect(link).not.toBeNull();
    const url = new URL(link![1]!);
    expect(url.pathname).toBe(`/b/${BILL}`);
    expect(await readToken(url.searchParams.get("t")!, "k", Date.now())).toEqual({ billId: BILL, participantId: "marcus" });
  });

  it("drops a reopened bill both ways, and brings it back on Confirm", async () => {
    await seedSaigon(db, BILL);
    await confirmed();

    await reopenBill(db, BILL);
    expect((await run(debtsCommand("guild"))).data.content).toMatch(/all square/);
    expect((await run(debtsCommand("guild", false, "marcus"))).data.content).toMatch(/all square/);

    await confirmed();
    expect((await run(debtsCommand("guild"))).data.content).toContain("You're owed");
    expect((await run(debtsCommand("guild", false, "marcus"))).data.content).toContain("You owe");
  });

  it("says they're all square when nothing is left either way", async () => {
    await seedSaigon(db, BILL);

    const reply = await run(debtsCommand("guild", false, "marcus"));

    expectPrivate(reply);
    expect(reply.data.content).toMatch(/all square/i);
    expect(reply.data.content).toContain("/debts everywhere:True");
  });
});

describe("renderDebts", () => {
  const url = (b: BillDebt) => `https://aazhi.example/b/${b.billId}?t=${"x".repeat(170)}`;

  it("keeps both sections inside Discord's limit, and every line adds up, however long the lists", () => {
    const rows = [
      ...Array.from({ length: 300 }, (_, i) => debt(`mine-${i}`, `person-${i % 40}`, 1000 + i)),
      ...Array.from({ length: 60 }, (_, i) => debt(`theirs-${i}`, "gavin", 2000 + i, { payer: `friend-${i % 7}`, payerName: `friend-${i % 7}` })),
    ];

    const text = renderDebts(rows, "gavin", true, url);

    expect(text.length).toBeLessThanOrEqual(2000);
    const lines = text.split("\n").filter(Boolean);
    const owe = lines.findIndex((l) => l.startsWith("**You owe"));
    expect(owe).toBeGreaterThan(0);
    for (const part of [lines.slice(0, owe), lines.slice(owe)]) {
      const total = dollars(/\$[\d,.]+/.exec(part[0]!)![0]);
      const people = part.slice(1).filter((l) => !l.startsWith("- "));
      expect(people.reduce((n, l) => n + dollars(l.slice(l.lastIndexOf("$"))), 0)).toBe(total);
      // Bill lines under a person add up to that person's line.
      let at = 1;
      while (at < part.length && !part[at]!.startsWith("and ")) {
        let under = 0;
        const head = part[at]!;
        at++;
        while (at < part.length && part[at]!.startsWith("- ")) {
          under += dollars(part[at]!.slice(part[at]!.lastIndexOf("$")));
          at++;
        }
        expect(under).toBe(dollars(head.slice(head.lastIndexOf("$"))));
      }
    }
  });

  it("gives You owe the room You're owed leaves", () => {
    const rows = Array.from({ length: 6 }, (_, i) => debt(`b-${i}`, "gavin", 500, { payer: "marcus", payerName: "Marcus" }));

    const text = renderDebts([debt("mine", "dani", 500), ...rows], "gavin", false, url);

    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain(url(rows[5]!));
  });

  it("escapes a place so it can't break out of its link", () => {
    const text = renderDebts([debt("b", "gavin", 500, { payer: "m", payerName: "M", place: "Joe's [bar](x)" })], "gavin", false, url);

    expect(text).toContain("- [Joe's \\[bar\\](x), Oct 28, 2026](<");
  });
});
