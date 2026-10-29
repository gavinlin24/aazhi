import { createExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/index";
import type { BillRow, Participant } from "../../src/db/bills";
import type { Env } from "../../src/env";
import { splitBill } from "../../src/money/split";
import type { BillInput } from "../../src/money/types";
import { CLIENT_SCRIPT } from "../../src/web/client";
import { renderPage } from "../../src/web/page";
import { mintToken, TOKEN_TTL_MS } from "../../src/web/token";
import { SAIGON, withItem, withUnclaimed } from "../fixtures/saigon";
import { SAIGON_NAMES, seedSaigon } from "../fixtures/seed";
import { one, select, textOf } from "./html";

const db = workerEnv.DB;
const KEY = "page-test-signing-key";

const bill: BillRow = {
  id: "bill-1",
  guildId: "guild-1",
  channelId: "chan-1",
  messageId: "msg-1",
  payerId: "gavin",
  place: "Saigon Kitchen",
  billDate: "2026-10-28",
  taxCents: 2232,
  tipCents: 5030,
  printedTotalCents: 27382,
  status: "draft",
  revision: 7,
  createdAt: "2026-10-28T20:00:00.000Z",
  confirmedAt: null,
};

function participantsOf(input: BillInput): Participant[] {
  return input.participants.map((id) => ({
    billId: bill.id,
    id,
    kind: "member",
    displayName: SAIGON_NAMES[id] ?? id,
    addedBy: null,
  }));
}

// Tea and water unclaimed: the spec's mid-dinner draft.
const draft = withUnclaimed(SAIGON, ["tea", "water"]);

function page(viewer: string, b: BillRow = bill, input: BillInput = draft, people: Participant[] = participantsOf(input)) {
  return renderPage(b, splitBill(input), input.items, people, viewer);
}

function stateOf(html: string): any {
  const match = /<script type="application\/json" id="bill-state">([\s\S]*?)<\/script>/.exec(html);
  expect(match, "state block").not.toBeNull();
  return JSON.parse(match![1]!);
}

describe("renderPage", () => {
  it("renders every line item and a chip per participant", async () => {
    const html = page("marcus");

    const rows = await select(html, "li.item");
    expect(rows.map((r) => r.attrs["data-item"])).toEqual(SAIGON.items.map((i) => i.id));
    for (const item of SAIGON.items) {
      const row = rows.find((r) => r.attrs["data-item"] === item.id)!;
      expect(row.text).toContain(item.label);
      const chips = await select(html, `li.item[data-item="${item.id}"] button.chip`);
      expect(chips.map((c) => c.attrs["data-participant"]).sort()).toEqual([...SAIGON.participants].sort());
    }
    expect(await textOf(html, 'li.item[data-item="noodles"] .item-price')).toBe("$32.00");
  });

  it("fills the chips of the people who claimed a line and flags lines nobody claimed", async () => {
    const html = page("marcus");

    const rolls = await select(html, 'li.item[data-item="rolls"] button.chip[aria-pressed="true"]');
    expect(rolls.map((c) => c.attrs["data-participant"]).sort()).toEqual(["dani", "marcus", "omar"]);
    expect(await select(html, 'li.item[data-item="tea"] button.chip[aria-pressed="true"]')).toEqual([]);

    const flagged = await select(html, "li.item.is-unclaimed");
    expect(flagged.map((r) => r.attrs["data-item"])).toEqual(["tea", "water"]);
    expect(flagged[0]!.text).toMatch(/nobody/i);
  });

  it("marks the viewer so the page knows whose chip is editable", async () => {
    const html = page("marcus");

    const root = await one(html, "#bill");
    expect(root.attrs).toMatchObject({
      "data-bill-id": "bill-1",
      "data-viewer": "marcus",
      "data-payer": "gavin",
      "data-viewer-is-payer": "false",
      "data-editable": "self",
      "data-status": "draft",
      "data-revision": "7",
    });

    const mine = await select(html, "button.chip.is-viewer");
    expect(mine).toHaveLength(SAIGON.items.length);
    expect(new Set(mine.map((c) => c.attrs["data-participant"]))).toEqual(new Set(["marcus"]));
    expect(mine.every((c) => !("disabled" in c.attrs))).toBe(true);

    const others = await select(html, "button.chip:not(.is-viewer)");
    expect(others).toHaveLength(SAIGON.items.length * 7);
    expect(others.every((c) => "disabled" in c.attrs)).toBe(true);
  });

  it("lets the payer edit every chip", async () => {
    const html = page("gavin");

    expect((await one(html, "#bill")).attrs).toMatchObject({ "data-viewer-is-payer": "true", "data-editable": "all" });
    expect(await select(html, "button.chip[disabled]")).toEqual([]);
    expect(await select(html, "button.chip")).toHaveLength(SAIGON.items.length * 8);
  });

  it("lets nobody edit a bill that is no longer a draft", async () => {
    for (const viewer of ["gavin", "marcus"]) {
      const html = page(viewer, { ...bill, status: "confirmed", confirmedAt: "2026-10-28T22:00:00.000Z" }, SAIGON);
      expect((await one(html, "#bill")).attrs["data-editable"]).toBe("none");
      expect(await select(html, "button.chip:not([disabled])")).toEqual([]);
    }
  });

  it("gives every chip an accessible name and toggle state, inside a group named for its line", async () => {
    const html = page("marcus");

    const chips = await select(html, "button.chip");
    for (const chip of chips) {
      expect(chip.attrs.type).toBe("button");
      expect(["true", "false"]).toContain(chip.attrs["aria-pressed"]);
      expect(chip.text.length).toBeGreaterThan(0);
    }
    const group = await one(html, 'li.item[data-item="tea"] [role="group"]');
    expect(group.attrs["aria-label"]).toContain("Thai iced tea x3");
    expect(html).toMatch(/\.chip\s*\{[^}]*min-height:\s*44px/);
  });

  it("shows the viewer's running amount up front", async () => {
    const html = page("marcus");
    const marcus = splitBill(draft).shares.find((s) => s.participant === "marcus")!;

    expect(await textOf(html, "[data-you-owed]")).toBe("$38.02");
    const detail = await textOf(html, "[data-you-detail]");
    expect(detail).toContain("$29.50");
    expect(detail).toContain(`$${(marcus.taxCents / 100).toFixed(2)}`);
    expect(detail).toContain(`$${(marcus.tipCents / 100).toFixed(2)}`);
    expect(await textOf(html, "[data-you]")).toMatch(/Gavin/);
  });

  it("tells the payer their own share and what the table owes them", async () => {
    const html = page("gavin");
    const result = splitBill(draft);
    const gavin = result.shares.find((s) => s.participant === "gavin")!;

    expect(await textOf(html, "[data-you-owed]")).toBe(`$${(gavin.owedCents / 100).toFixed(2)}`);
    expect(await textOf(html, "[data-you]")).toContain(`$${(result.payerCollectsCents / 100).toFixed(2)}`);
  });

  it("shows per-person totals, the bill totals and the unclaimed shortfall", async () => {
    const html = page("marcus");

    expect(await textOf(html, '[data-share="marcus"]')).toBe("$38.02");
    expect(await textOf(html, '[data-share="jess"]')).toBe("$37.38");
    expect(await textOf(html, '[data-total="subtotal"]')).toBe("$251.50");
    expect(await textOf(html, '[data-total="tax"]')).toBe("$22.32");
    expect(await textOf(html, '[data-total="tip"]')).toBe("$50.30");
    expect(await textOf(html, '[data-total="total"]')).toBe("$324.12");
    expect(await textOf(html, '[data-total="unclaimed"]')).toBe("$27.06");
  });

  it("drops the shortfall line once every line is claimed", async () => {
    const html = page("marcus", bill, SAIGON);
    expect(await select(html, '[data-total="unclaimed"]')).toEqual([]);
  });

  it("puts the place, the date and the payer in the header", async () => {
    const header = await textOf(page("marcus"), "header");
    expect(header).toContain("Saigon Kitchen");
    expect(header).toContain("Oct 28, 2026");
    expect(header).toContain("Gavin");

    const untitled = await textOf(page("marcus", { ...bill, place: null, billDate: null }), "header");
    expect(untitled).toContain("Receipt");
  });

  it("renders a guest's chip like anyone else's", async () => {
    const input = withItem({ ...draft, participants: [...draft.participants, "guest-sam"] }, {
      id: "wine",
      label: "Glass of wine",
      cents: 1200,
      claimedBy: ["guest-sam"],
    });
    const people: Participant[] = [
      ...participantsOf(draft),
      { billId: bill.id, id: "guest-sam", kind: "guest", displayName: "Sam", addedBy: "dani" },
    ];
    const html = page("gavin", bill, input, people);

    const chip = await one(html, 'li.item[data-item="wine"] button.chip[data-participant="guest-sam"]');
    expect(chip.attrs["aria-pressed"]).toBe("true");
    expect(chip.text).toBe("Sam");
  });

  it("escapes text that came from the receipt or from people", async () => {
    const place = `<img src=x onerror="alert(1)">`;
    const label = `</script><script>alert("label")</script> & 'friends'`;
    const name = `"><b onclick=alert(2)>Ann</b>`;
    const input = withItem({ ...draft, participants: [...draft.participants, "ann"] }, {
      id: "odd",
      label,
      cents: 100,
      claimedBy: ["ann"],
    });
    const people: Participant[] = [
      ...participantsOf(draft),
      { billId: bill.id, id: "ann", kind: "member", displayName: name, addedBy: null },
    ];
    const html = renderPage({ ...bill, place }, splitBill(input), input.items, people, "ann");

    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b onclick");
    expect(html).not.toContain(`<script>alert`);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    // Exactly the two script elements the page means to have.
    expect(await select(html, "script")).toHaveLength(2);
    expect(await select(html, "img, b")).toEqual([]);

    const state = stateOf(html);
    expect(state.items.find((i: any) => i.id === "odd").label).toBe(label);
    expect(state.participants.find((p: any) => p.id === "ann").displayName).toBe(name);
  });

  it("hands the script the state it starts from", () => {
    const state = stateOf(page("marcus"));
    expect(state).toMatchObject({
      billId: "bill-1",
      viewer: "marcus",
      payerId: "gavin",
      status: "draft",
      revision: 7,
      editable: "self",
      taxCents: 2232,
      tipCents: 5030,
    });
    expect(state.items).toHaveLength(SAIGON.items.length);
    expect(state.participants.map((p: any) => p.id)).toEqual(SAIGON.participants);
    expect(state.result.unclaimedCents).toBe(2706);
  });

  it("is one self-contained, phone-sized page that follows the system theme", () => {
    const html = page("marcus");

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1');
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).not.toMatch(/\bsrc=|<link\b|@import|url\(|https?:\/\//);
    expect(html).toContain(CLIENT_SCRIPT);
    expect(CLIENT_SCRIPT).not.toMatch(/<\/script/i);
  });
});

function env(): Env {
  return {
    DB: db,
    DISCORD_PUBLIC_KEY: "00",
    DISCORD_BOT_TOKEN: "unused",
    DISCORD_APPLICATION_ID: "unused",
    ANTHROPIC_API_KEY: "unused",
    TOKEN_SIGNING_KEY: KEY,
  };
}

async function get(path: string): Promise<Response> {
  return app.fetch(new Request(`https://aazhi.test${path}`), env(), createExecutionContext());
}

async function linkFor(billId: string, participant: string, nowMs = Date.now()): Promise<string> {
  return `/b/${billId}?t=${await mintToken(billId, participant, KEY, nowMs)}`;
}

function expectPrivate(response: Response) {
  expect(response.headers.get("content-type")).toMatch(/^text\/html;\s*charset=utf-8$/i);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toBe("no-store");
}

describe("GET /b/:billId", () => {
  beforeEach(async () => {
    await db.prepare("DELETE FROM bills").run();
    await seedSaigon(db, "bill-1", { unclaimed: ["tea", "water"] });
  });

  it("serves the page to the person the link was minted for", async () => {
    const response = await get(await linkFor("bill-1", "marcus"));

    expect(response.status).toBe(200);
    expectPrivate(response);
    const html = await response.text();
    expect((await one(html, "#bill")).attrs["data-viewer"]).toBe("marcus");
    expect(await textOf(html, "[data-you-owed]")).toBe("$38.02");
    expect(await textOf(html, '[data-total="unclaimed"]')).toBe("$27.06");
  });

  it("returns 403 and tells the visitor to tap the button again", async () => {
    const expired = await linkFor("bill-1", "marcus", Date.now() - TOKEN_TTL_MS - 1);
    const valid = await linkFor("bill-1", "marcus");
    const tampered = valid.slice(0, -2) + (valid.endsWith("AA") ? "BB" : "AA");

    for (const path of ["/b/bill-1", "/b/bill-1?t=", "/b/bill-1?t=garbage", expired, tampered]) {
      const response = await get(path);
      expect(response.status, path).toBe(403);
      expectPrivate(response);
      const html = await response.text();
      expect(html).toMatch(/Open the split/);
      expect(html).toMatch(/Discord/);
      expect(html).not.toContain("Saigon Kitchen");
      expect(html).not.toContain("$38.02");
      expect(html).not.toContain("bill-state");
    }
  });

  it("refuses a link minted for another bill", async () => {
    await seedSaigon(db, "bill-2", { bill: { place: "Other Place" } });

    const response = await get(`/b/bill-1?t=${(await linkFor("bill-2", "marcus")).split("?t=")[1]}`);

    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).not.toContain("Saigon Kitchen");
    expect(html).not.toContain("Other Place");
  });

  it("returns 404 for a bill that does not exist", async () => {
    const response = await get(await linkFor("no-such-bill", "marcus"));

    expect(response.status).toBe(404);
    expectPrivate(response);
    expect(await response.text()).not.toContain("bill-state");
  });

  it("says a superseded split was replaced instead of showing it", async () => {
    await db.prepare("UPDATE bills SET status = 'superseded' WHERE id = 'bill-1'").run();

    const response = await get(await linkFor("bill-1", "marcus"));

    expectPrivate(response);
    const html = await response.text();
    expect(html).toMatch(/replaced/i);
    expect(html).toMatch(/newer/i);
    expect(html).not.toContain("Spring rolls");
    expect(html).not.toContain("bill-state");
  });

  it("says a deleted split was deleted instead of showing it", async () => {
    await db.prepare("UPDATE bills SET status = 'deleted' WHERE id = 'bill-1'").run();

    const response = await get(await linkFor("bill-1", "marcus"));

    const html = await response.text();
    expect(html).toMatch(/deleted/i);
    expect(html).not.toContain("Spring rolls");
  });
});
