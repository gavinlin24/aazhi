import { createExecutionContext } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/index";
import type { BillRow, Participant } from "../../src/db/bills";
import type { Env } from "../../src/env";
import { formatCents } from "../../src/format";
import { splitBill } from "../../src/money/split";
import type { BillInput } from "../../src/money/types";
import { CLIENT_SCRIPT } from "../../src/web/client";
import { renderPage } from "../../src/web/page";
import type { StateExtras } from "../../src/web/state";
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
  discountCents: 0,
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

// The day after the dinner, so the header's date drops the year it shares.
const NOW = Date.parse("2026-10-29T12:00:00.000Z");

function page(viewer: string, b: BillRow = bill, input: BillInput = draft, people: Participant[] = participantsOf(input)) {
  return renderPage(b, splitBill(input), input.items, people, viewer, {}, NOW);
}

function stateOf(html: string): any {
  const match = /<script type="application\/json" id="bill-state">([\s\S]*?)<\/script>/.exec(html);
  expect(match, "state block").not.toBeNull();
  return JSON.parse(match![1]!);
}

const confirmedBill: BillRow = { ...bill, status: "confirmed", confirmedAt: "2026-10-28T22:00:00.000Z" };
const sam: Participant = { billId: bill.id, id: "guest-sam", kind: "guest", displayName: "Sam", addedBy: "dani" };
const kim: Participant = { billId: bill.id, id: "guest-kim", kind: "guest", displayName: "Kim", addedBy: "gavin" };

describe("renderPage", () => {
  describe("a draft", () => {
    it("is the receipt: one row per line, with its price and the faces of whoever else had it", async () => {
      const html = page("marcus");

      expect((await one(html, "#bill")).attrs["data-layout"]).toBe("receipt");
      const rows = await select(html, "li.item");
      expect(rows.map((r) => r.attrs["data-item"])).toEqual(SAIGON.items.map((i) => i.id));
      for (const item of SAIGON.items) {
        expect(rows.find((r) => r.attrs["data-item"] === item.id)!.text).toContain(item.label);
      }
      expect(await textOf(html, 'li.item[data-item="noodles"] .item-price')).toBe("$32.00");
      // The viewer is the tick, never a face of their own.
      expect((await one(html, 'li.item[data-item="rolls"] .who .stack')).attrs["aria-label"]).toBe("Dani, Omar");
      expect(await select(html, 'li.item[data-item="bun"] .who .stack')).toEqual([]);
      expect(await select(html, ".items .stack .av.is-viewer")).toEqual([]);
    });

    it("ticks the viewer's lines and rings the ones nobody claimed", async () => {
      const html = page("marcus");

      expect((await select(html, "li.item.is-mine")).map((r) => r.attrs["data-item"])).toEqual(["rolls", "bun"]);
      const pressed = await select(html, '[data-claim][aria-pressed="true"]');
      expect(pressed.map((b) => b.attrs["data-item"])).toEqual(["rolls", "bun"]);
      expect((await select(html, "li.item.is-unclaimed")).map((r) => r.attrs["data-item"])).toEqual(["tea", "water"]);
      expect(html).toMatch(/\.is-unclaimed \.tick\s*\{[^}]*dashed/);

      const ring = await one(html, "[data-bar] [data-jump-unclaimed]");
      expect(ring.text).toBe("2 left");
      expect(ring.attrs["aria-label"]).toBe("2 left to claim");
      expect(await select(page("marcus", bill, SAIGON), "[data-jump-unclaimed]")).toEqual([]);
    });

    it("shows the viewer's piece of a shared line, and nothing on a line that is theirs alone", async () => {
      const html = page("marcus");

      expect(await textOf(html, 'li.item[data-item="rolls"] .piece')).toBe("÷3$5.00");
      expect(await textOf(html, 'li.item[data-item="bun"] .piece')).toBe("");
      expect(await textOf(html, 'li.item[data-item="banhxeo"] .piece')).toBe("");
    });

    it("drops the avatar line on a row nobody else has, and keeps it bare once the viewer claims it", async () => {
      const html = page("marcus");
      const bare = async (id: string) => (await one(html, `li.item[data-item="${id}"]`)).attrs.class.split(" ").includes("is-bare");

      for (const item of SAIGON.items) {
        expect(await select(html, `li.item[data-item="${item.id}"] .piece`), item.id).toHaveLength(1);
        expect(await select(html, `li.item[data-item="${item.id}"] .who`), item.id).toHaveLength(1);
      }
      // Bun bo Hue is Marcus's alone; spring rolls are shared.
      expect(await bare("bun")).toBe(true);
      expect(await bare("rolls")).toBe(false);
      expect(html).toMatch(/\.row\s*\{[^}]*grid-template-rows:\s*23px 22px/);
      expect(html).toMatch(/\.is-bare \.row\s*\{[^}]*grid-template-rows:\s*30px/);
    });

    it("marks the viewer, and gives a member one tap per line for their own claim", async () => {
      const html = page("marcus");

      expect((await one(html, "#bill")).attrs).toMatchObject({
        "data-bill-id": "bill-1",
        "data-viewer": "marcus",
        "data-payer": "gavin",
        "data-viewer-is-payer": "false",
        "data-editable": "self",
        "data-status": "draft",
        "data-revision": "7",
      });
      const claims = await select(html, "button.row[data-claim]");
      expect(claims).toHaveLength(SAIGON.items.length);
      expect(new Set(claims.map((c) => c.attrs["data-participant"]))).toEqual(new Set(["marcus"]));
      expect(await select(html, "[data-open-line], .tick-btn, li.is-locked")).toEqual([]);
    });

    it("gives the payer their own tick apart from the rest of the line, which opens who had it", async () => {
      const html = page("gavin");

      expect((await one(html, "#bill")).attrs).toMatchObject({ "data-viewer-is-payer": "true", "data-editable": "all" });
      const ticks = await select(html, "button.tick-btn[data-claim]");
      expect(ticks).toHaveLength(SAIGON.items.length);
      expect(new Set(ticks.map((t) => t.attrs["data-participant"]))).toEqual(new Set(["gavin"]));
      const lines = await select(html, "button.row[data-open-line]");
      expect(lines.map((l) => l.attrs["data-open-line"])).toEqual(SAIGON.items.map((i) => i.id));
      expect(lines.every((l) => l.attrs["aria-haspopup"] === "dialog" && !("data-claim" in l.attrs))).toBe(true);
    });

    it("gives every tap target a name and a toggle state, and a finger's room", async () => {
      const html = page("marcus");

      for (const button of await select(html, "button[data-claim]")) {
        expect(button.attrs.type).toBe("button");
        expect(["true", "false"]).toContain(button.attrs["aria-pressed"]);
      }
      expect((await one(html, 'li.item[data-item="rolls"] button')).attrs["aria-label"]).toBe("Spring rolls, $15.00, with Dani, Omar");
      expect((await one(html, 'li.item[data-item="bun"] button')).attrs["aria-label"]).toBe("Bun bo Hue, $24.50");
      expect((await one(page("gavin"), 'li.item[data-item="beef"] .tick-btn')).attrs["aria-label"]).toBe("Shaking beef, Gavin");
      expect(html).toMatch(/\.tick-btn\s*\{[^}]*width:\s*44px/);
      expect(html).toMatch(/\.back\s*\{[^}]*min-height:\s*44px/);
    });
  });

  it("lets nobody edit a bill that is no longer a draft", async () => {
    for (const viewer of ["gavin", "marcus"]) {
      const html = page(viewer, confirmedBill, SAIGON);
      expect((await one(html, "#bill")).attrs["data-editable"]).toBe("none");
      expect(await select(html, "[data-claim], [data-open-line], [data-edit-field], [data-add-line], [data-add-guest], [data-open-payer]")).toEqual([]);
      expect(await select(html, "li.item.is-locked")).toHaveLength(SAIGON.items.length);
    }
  });

  it("shows the viewer's running amount in the bar and each person's on their tile", async () => {
    const html = page("marcus");

    expect(await textOf(html, "[data-you-owed]")).toBe("$38.02");
    const bar = await one(html, "[data-bar]");
    expect(bar.text).toContain("$38.02");
    // Amount, arrow, whoever receives it: the payer.
    expect(await textOf(html, "[data-bar] .owe")).toBe("you owe $38.02");
    expect(await textOf(html, "[data-bar] .bar-in > .av.payer")).toBe("G");
    expect(await select(html, "[data-bar] .stack")).toEqual([]);
    expect(await textOf(html, '[data-owed="marcus"]')).toBe("$38.02");
    expect(await textOf(html, '[data-owed="jess"]')).toBe("$37.38");

    // The viewer first, so the face they look for is always where they look.
    const tiles = await select(html, "button.tile[data-person]");
    expect(tiles.map((t) => t.attrs["data-person"])).toEqual(["marcus", "dani", "gavin", "jess", "lena", "omar", "priya", "theo"]);
    expect(tiles[0]!.attrs["aria-label"]).toBe("Marcus (you), $38.02");
    expect(tiles[0]!.text).toContain("Marcus");
    expect(tiles.find((t) => t.attrs["data-person"] === "gavin")!.attrs["aria-label"]).toMatch(/^Gavin, \$[\d.]+, paid the bill$/);
    expect(await select(html, '[data-person="gavin"] .badge.coin')).toHaveLength(1);
    expect(await select(html, ".badge.coin")).toHaveLength(1);
  });

  it("tells the payer what the table owes them", async () => {
    const html = page("gavin");
    expect(await textOf(html, "[data-you-owed]")).toBe(`$${(splitBill(draft).payerCollectsCents / 100).toFixed(2)}`);
    // The same order as everyone else's bar, with the payer as the one receiving.
    expect(await textOf(html, "[data-bar] .owe-label")).toBe("to collect");
    expect((await one(html, "[data-bar] .bar-in > .av.payer")).attrs.class).toContain("is-viewer");
    expect(await select(html, "[data-bar] .stack")).toEqual([]);
  });

  describe("who a tap claims for", () => {
    const withSam = { ...draft, participants: [...draft.participants, "guest-sam"] };
    const people = [...participantsOf(draft), sam];

    it("puts you and your guests in the bar, you pressed, so switching is one tap", async () => {
      const html = page("dani", bill, withSam, people);

      const row = await one(html, "[data-bar] [data-claimers]");
      expect(row.attrs.hidden).toBeUndefined();
      expect(row.attrs["aria-label"]).toBe("Claim for");
      const chips = await select(html, "[data-claimers] button.claimer");
      // Each chip carries that person's share of the total beside them.
      const owed = (id: string) => formatCents(splitBill(withSam).shares.find((x) => x.participant === id)!.owedCents);
      expect(chips.map((c) => [c.attrs["data-claim-as"], c.attrs["aria-pressed"], c.text])).toEqual([
        ["dani", "true", `DDani${owed("dani")}`],
        ["guest-sam", "false", `SSam${owed("guest-sam")}`],
      ]);
      expect(html).toMatch(/\.claimers\[hidden\]\s*\{\s*display:\s*none/);
    });

    it("stays out of the way for anyone with nobody else to claim for", async () => {
      for (const viewer of ["marcus", "gavin"]) {
        const html = page(viewer, bill, withSam, people);
        expect((await one(html, "[data-claimers]")).attrs.hidden, viewer).toBe("");
        expect(await select(html, "[data-claimers] button"), viewer).toEqual([]);
      }
    });
  });

  it("shows the bill totals and the unclaimed shortfall once each", async () => {
    const html = page("marcus");

    expect(await textOf(html, '[data-total="subtotal"]')).toBe("$251.50");
    expect(await textOf(html, '[data-total="tax"]')).toBe("$22.32");
    expect(await textOf(html, '[data-total="tip"]')).toBe("$50.30");
    expect(await textOf(html, '[data-field-row="tax"] dt')).toBe("Tax (8.9%)");
    expect(await textOf(html, '[data-field-row="tip"] dt')).toBe("Tip (20.0%)");
    expect(await textOf(html, ".trow.grand [data-total]")).toBe("$324.12");
    expect(await textOf(html, '[data-total="total"]')).toBe("$324.12");
    expect(await textOf(html, '[data-total="unclaimed"]')).toBe("$27.06");
  });

  it("reads the payer's receipt as subtotal less discount plus tax, before the tip", async () => {
    const rows = await select(page("gavin"), ".totals > .trow");
    expect(rows.map((r) => /^[A-Za-z]+/.exec(r.text)?.[0])).toEqual(["Subtotal", "Discount", "Tax", "Receipt", "Tip", "Total", "Unclaimed"]);
    expect(rows[3]!.attrs.class).toContain("receipt-row");
  });

  it("shows a whole-bill discount as money off between the subtotal and tax", async () => {
    const discounted = { ...SAIGON, discountCents: 2515 };
    const html = page("marcus", { ...bill, discountCents: 2515, printedTotalCents: 27382 - 2515 }, discounted);

    const rows = await select(html, "[data-totals] .trow dt");
    expect(rows.slice(0, 3).map((r) => r.text)).toEqual(["Subtotal", "Discount (10.0%)", "Tax (8.9%)"]);
    expect(await textOf(html, '[data-total="discount"]')).toBe("-$25.15");
    expect(await textOf(html, '[data-total="total"]')).toBe("$298.97");
    // Only the payer can change it.
    expect(await select(html, '[data-edit-field="discount"]')).toEqual([]);
  });

  it("hides a zero discount from everyone but the payer, who adds one from that row", async () => {
    expect(await select(page("marcus"), '[data-field-row="discount"]')).toEqual([]);
    expect(await select(page("marcus", confirmedBill, SAIGON), '[data-field-row="discount"]')).toEqual([]);

    const payer = await one(page("gavin"), 'button.amt[data-edit-field="discount"]');
    expect(payer.attrs["aria-label"]).toBe("Discount, $0.00");
    expect(payer.text).toBe("$0.00");
  });

  it("drops the shortfall line once every line is claimed", async () => {
    const html = page("marcus", bill, SAIGON);
    expect(await select(html, '[data-total="unclaimed"]')).toEqual([]);
  });

  it("puts the place, the date and the payer in the header", async () => {
    const header = await textOf(page("marcus"), "header");
    expect(header).toContain("Saigon Kitchen");
    expect(header).toContain("Oct 28");
    expect(header).not.toContain("2026");
    expect(header).toContain("Gavin");

    const lastYear = renderPage(bill, splitBill(draft), draft.items, participantsOf(draft), "marcus", {}, Date.parse("2027-01-02T00:00:00Z"));
    expect(await textOf(lastYear, "header")).toContain("Oct 28, 2026");
    const untitled = await textOf(page("marcus", { ...bill, place: null, billDate: null }), "header");
    expect(untitled).toContain("Receipt");
  });

  it("names each person rather than calling anyone You", async () => {
    const html = page("marcus");
    expect(html).not.toMatch(/>\s*You\s*</);
    expect(await textOf(html, '[data-person="marcus"] .tile-name')).toBe("Marcus");
  });

  it("draws a guest on the tile of whoever brought them, with the guest's share in theirs", async () => {
    const input = withItem({ ...draft, participants: [...draft.participants, "guest-sam"] }, {
      id: "wine",
      label: "Glass of wine",
      cents: 1200,
      claimedBy: ["guest-sam"],
    });
    const html = page("gavin", bill, input, [...participantsOf(draft), sam]);
    const result = splitBill(input);
    const owed = (id: string) => result.shares.find((x) => x.participant === id)!.owedCents;

    const face = await one(html, 'li.item[data-item="wine"] .who .stack');
    expect(face.attrs["aria-label"]).toBe("Sam");
    expect(await select(html, 'li.item[data-item="wine"] .av.is-guest')).toHaveLength(1);
    expect(await select(html, '[data-person="guest-sam"]')).toEqual([]);
    expect(await select(html, '[data-person="dani"] .minis .av.is-guest')).toHaveLength(1);
    expect((await one(html, '[data-person="dani"]')).attrs["aria-label"]).toContain("with Sam");
    expect(stateOf(html).owing.dani.owedCents).toBe(owed("dani") + owed("guest-sam"));
    expect(await textOf(html, '[data-owed="dani"]')).toBe(`$${((owed("dani") + owed("guest-sam")) / 100).toFixed(2)}`);
  });

  it("offers a guest to anyone on a draft, right among the people", async () => {
    for (const viewer of ["gavin", "marcus"]) {
      const slot = await one(page(viewer), "[data-people] li[data-add-guest-slot]");
      expect(slot.attrs.class).toContain("needs-js");
      expect(slot.text).toMatch(/^Guest/);
    }
    const outsider = participantsOf(draft).filter((p) => p.id !== "marcus");
    const input = { ...withUnclaimed(draft, ["rolls", "bun"]), participants: draft.participants.filter((p) => p !== "marcus") };
    expect(await select(page("marcus", bill, input, outsider), "[data-add-guest]")).toEqual([]);
  });

  it("shows each add-on on its own line under the dish, and reads them out with it", async () => {
    const addons = [{ label: "Extra patty", cents: 300 }, { label: "No onions", cents: 0 }, { label: "No cheese", cents: -50 }];
    const note = "Extra patty +$3.00, No onions, No cheese -$0.50";
    const input = withItem(withItem(draft, { id: "burger", label: "Burger", addons, cents: 1950, claimedBy: ["marcus"] }), {
      id: "odd",
      label: "Odd",
      addons: [{ label: "<b>bold</b>", cents: 0 }],
      cents: 100,
      claimedBy: [],
    });
    const html = renderPage(bill, splitBill(input), input.items, participantsOf(input), "marcus", {}, NOW);

    const row = await one(html, 'li.item[data-item="burger"]');
    expect(row.attrs.class.split(" ")).toContain("has-addons");
    const lines = await select(html, 'li.item[data-item="burger"] .item-addons .addon-line');
    expect(lines.map((l) => l.text)).toEqual(["Extra patty+$3.00", "No onions", "No cheese-$0.50"]);
    expect((await select(html, 'li.item[data-item="burger"] .addon-price')).map((p) => p.text)).toEqual(["+$3.00", "-$0.50"]);
    expect(html).not.toContain("<b>bold");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect((await one(html, 'li.item[data-item="burger"] [aria-label]')).attrs["aria-label"]).toBe(`Burger (${note}), $19.50`);
    expect(await select(html, 'li.item[data-item="bun"] .item-addons')).toEqual([]);
    expect(stateOf(html).items.find((i: any) => i.id === "burger").addons).toEqual(addons);
  });

  it("keeps add-on prices plain for the payer, whose brush is on the dish's price", async () => {
    const addons = [{ label: "Extra patty", cents: 300 }, { label: "No onions", cents: 0 }];
    const input = withItem(draft, { id: "burger", label: "Burger", addons, cents: 1950, claimedBy: [] });
    const html = renderPage(bill, splitBill(input), input.items, participantsOf(input), "gavin", {}, NOW);

    expect((await select(html, 'li.item[data-item="burger"] .addon-line')).map((l) => l.text)).toEqual(["Extra patty+$3.00", "No onions"]);
    expect(await select(html, 'li.item[data-item="burger"] .item-addons svg')).toEqual([]);
    expect(await select(html, 'li.item[data-item="burger"] .item-price svg')).toHaveLength(1);
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
      viewerIsPayer: false,
      taxCents: 2232,
      tipCents: 5030,
      printedTotalCents: 27382,
      reconciles: { ok: true, discrepancyCents: null },
      pay: [],
    });
    expect(state.owing.marcus).toEqual({ owedCents: 3802, paidCents: 0 });
    expect(state.owing).not.toHaveProperty("guest-sam");
    expect(state.items).toHaveLength(SAIGON.items.length);
    expect(state.participants.map((p: any) => p.id)).toEqual(SAIGON.participants);
    expect(state.result.unclaimedCents).toBe(2706);
  });

  it("gives a viewer who is not on the bill nothing to tap and tells them how to join", async () => {
    const people = participantsOf(draft).filter((p) => p.id !== "marcus");
    const input = { ...withUnclaimed(draft, ["rolls", "tea", "bun"]), participants: draft.participants.filter((p) => p !== "marcus") };
    const html = page("marcus", bill, input, people);

    expect((await one(html, "#bill")).attrs["data-editable"]).toBe("none");
    expect(await select(html, "[data-claim], [data-bar]")).toEqual([]);
    expect(await textOf(html, "[data-you]")).toMatch(/not on this bill/i);
    expect(await textOf(html, "[data-you]")).toMatch(/Open the split/);
    expect((await one(html, "#bill")).attrs.class).not.toContain("has-bar");
  });

  it("names each status for what it is, and seals a confirmed bill", async () => {
    expect(await textOf(page("marcus"), "[data-status-label] .word")).toBe("Draft");
    expect(await select(page("marcus"), "[data-status-label] .seal")).toEqual([]);
    const confirmed = page("marcus", confirmedBill, SAIGON);
    expect(await textOf(confirmed, "[data-status-label] .word")).toBe("Confirmed");
    expect(await textOf(confirmed, "[data-status-label] .seal")).toBe("定");
    expect(await textOf(page("marcus", { ...bill, status: "reading" }, SAIGON), "[data-status-label] .word")).toBe("Reading");
  });

  it("shows the payer whether the read adds up, and lets them fix each amount in place", async () => {
    const adds = page("gavin");
    expect((await one(adds, "[data-reconcile]")).attrs.class).toContain("is-ok");
    expect(await textOf(adds, "[data-reconcile] .mark")).toBe("Adds up");
    expect(await textOf(adds, '[data-total="printed"]')).toBe("$273.82");
    const fields = await select(adds, "button.amt[data-edit-field]");
    expect(fields.map((f) => f.attrs["data-edit-field"])).toEqual(["discount", "tax", "printedTotal", "tip"]);
    expect(fields.map((f) => f.attrs["aria-label"])).toEqual(["Discount, $0.00", "Tax, $22.32", "Printed total, $273.82", "Tip, $50.30"]);
    // Adding a line needs the script; without it the payer still sees the check.
    expect(await select(adds, "[data-add-line].needs-js")).toHaveLength(1);

    const misread = withItem(SAIGON, { id: "extra", label: "Misread", cents: 5000, claimedBy: [] });
    const over = page("gavin", bill, misread);
    expect((await one(over, "[data-reconcile]")).attrs.class).toContain("is-off");
    expect(await textOf(over, "[data-reconcile] .mark")).toBe("+$50.00");

    const unread = page("gavin", { ...bill, printedTotalCents: null });
    expect(await textOf(unread, "[data-reconcile] .mark")).toBe("Not entered");
    expect(await textOf(unread, '[data-total="printed"]')).toBe("—");
    expect((await one(unread, '[data-edit-field="printedTotal"]')).attrs["aria-label"]).toBe("Printed total, not entered");

    expect(await select(page("marcus"), "[data-reconcile], [data-add-line], [data-edit-field]")).toEqual([]);
    expect(await select(page("gavin", confirmedBill, SAIGON), "[data-reconcile], [data-add-line], [data-edit-field]")).toEqual([]);
  });

  it("marks every value the payer can change with a brush, and nothing anyone else sees", async () => {
    const payer = page("gavin");
    expect((await one(payer, "section[data-items]")).attrs.class).toContain("is-editable");
    expect(await select(payer, "li.item .item-price .brush")).toHaveLength(SAIGON.items.length);
    expect(await select(payer, "button.amt[data-edit-field] > .brush")).toHaveLength(4);
    expect(await select(payer, "header button.payer-chip .brush")).toHaveLength(1);
    // Read-only figures on the payer's own receipt stay plain.
    expect(await select(payer, '[data-total="subtotal"] .brush, [data-total="total"] .brush, .piece .brush')).toEqual([]);
    expect(payer).toContain('<symbol id="i-brush"');

    for (const html of [page("marcus"), page("gavin", confirmedBill, SAIGON)]) {
      expect(await select(html, ".brush")).toEqual([]);
      expect((await one(html, "section[data-items]")).attrs.class).not.toContain("is-editable");
    }
  });

  it("lets only the payer hand the bill to someone else, from the payer in the header", async () => {
    const chip = await one(page("gavin"), "header button.payer-chip[data-open-payer]");
    expect(chip.attrs["aria-haspopup"]).toBe("dialog");
    expect(chip.text).toBe("Paid by Gavin");

    const diner = page("marcus");
    expect(await select(diner, "[data-open-payer]")).toEqual([]);
    expect(await textOf(diner, "header span.payer-chip")).toBe("Paid by Gavin");
  });

  it("gives the payer Confirm and Delete, and says why Confirm is waiting", async () => {
    const html = page("gavin");

    const confirm = await one(html, "[data-actions] [data-confirm]");
    expect(confirm.text).toBe("定Confirm");
    expect(confirm.attrs).not.toHaveProperty("disabled");
    expect(await textOf(html, "#confirm-why")).toBe("2 lines have nobody on them.");
    expect(await textOf(html, "[data-actions] [data-delete-bill]")).toBe("Delete this bill");
    expect(await select(html, "[data-reopen], [data-ask=wrong], [data-sent]")).toEqual([]);

    const ready = page("gavin", bill, SAIGON);
    expect(await select(ready, "#confirm-why")).toEqual([]);

    const off = page("gavin", bill, withItem(SAIGON, { id: "extra", label: "Extra", cents: 600, claimedBy: ["dani"] }));
    expect((await one(off, "[data-confirm]")).attrs).toHaveProperty("disabled");
    expect(await textOf(off, "#confirm-why")).toBe("Line items do not add up to total!");

    const unread = page("gavin", { ...bill, printedTotalCents: null }, SAIGON);
    expect(await textOf(unread, "#confirm-why")).toBe("Enter the receipt total first.");
  });

  it("gives everyone else on a draft nothing to do to the bill as a whole", async () => {
    expect(await select(page("marcus"), "[data-actions]")).toEqual([]);
    expect(await select(page("zoe"), "[data-actions]")).toEqual([]);
  });

  it("hides the payer picker once anyone has paid, so it never offers a change the server refuses", async () => {
    const reopened = { ...bill, confirmedAt: "2026-10-28T22:00:00.000Z" };
    const html = renderPage(reopened, splitBill(SAIGON), SAIGON.items, participantsOf(SAIGON), "gavin", { hasPayments: true }, NOW);

    expect(await select(html, "[data-open-payer]")).toEqual([]);
    expect(await select(html, "header span.payer-chip")).toHaveLength(1);
    expect(stateOf(html).hasPayments).toBe(true);
    // The rest of the payer's corrections stay available.
    expect(await select(html, "[data-edit-field]")).toHaveLength(4);

    const unpaid = page("gavin");
    expect(await select(unpaid, "[data-open-payer]")).toHaveLength(1);
    expect(stateOf(unpaid).hasPayments).toBe(false);
  });

  describe("a confirmed bill", () => {
    const input: BillInput = {
      ...withItem(withItem(SAIGON, { id: "lobster", label: "Lobster", cents: 2000, claimedBy: ["guest-sam"] }), {
        id: "fries",
        label: "Fries",
        cents: 700,
        claimedBy: ["guest-kim"],
      }),
      participants: [...SAIGON.participants, "guest-sam", "guest-kim"],
      pardoned: ["marcus"],
    };
    const people = [...participantsOf(SAIGON), sam, kim];
    const result = splitBill(input);
    const share = (id: string) => result.shares.find((x) => x.participant === id)!;
    const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

    function view(viewer: string, extras: StateExtras = {}): string {
      return renderPage(confirmedBill, result, input.items, people, viewer, { paid: [], ...extras }, NOW);
    }

    it("opens on the viewer's share, with the receipt and the people a tap away", async () => {
      const html = view("dani");

      expect((await one(html, "#bill")).attrs).toMatchObject({ "data-layout": "share", class: "page" });
      expect(await select(html, "[data-bar]")).toEqual([]);
      expect(await select(html, '.view.is-active[data-view="home"] [data-you]')).toHaveLength(1);
      expect((await select(html, ".view")).map((v) => v.attrs["data-view"])).toEqual(["home", "receipt", "people"]);
      expect(await select(html, '#receipt[data-view="receipt"] [data-items]')).toHaveLength(1);
      expect(await select(html, '#people[data-view="people"] [data-people]')).toHaveLength(1);
      expect((await select(html, "a[data-go]")).map((a) => a.attrs.href)).toEqual(["#receipt", "#people"]);
      expect(await textOf(html, '[data-go="receipt"] .money')).toBe(money(result.distributableCents));
      expect(html).toMatch(/\.is-live\[data-layout="share"\] \.view:not\(\.is-active\)\s*\{[^}]*display:\s*none/);
    });

    it("rolls a guest into the share of whoever brought them, food, tax and tip together", async () => {
      const html = view("dani");
      const dani = share("dani");
      const guest = share("guest-sam");

      expect(await textOf(html, "[data-you-owed]")).toBe(money(dani.owedCents + guest.owedCents));
      expect((await one(html, "[data-you] .flow .stack")).attrs["aria-label"]).toBe("Dani, Sam");
      // A food, tax and tip bar would mix Sam's in with Dani's.
      expect(await select(html, "[data-you] .split-bar, [data-you-detail]")).toEqual([]);
      // Right under the one amount, whose it is.
      expect((await select(html, "[data-you] [data-who] li")).map((r) => r.text)).toEqual([
        `DYou${money(dani.owedCents)}`,
        `SSam${money(guest.owedCents)}`,
      ]);
      // The lines are grouped the same way.
      const groups = await select(html, "[data-mine] .mine-group");
      expect(groups).toHaveLength(2);
      expect(groups[0]!.text).toMatch(/^DYou.*Garlic noodles/);
      expect(groups[0]!.text).not.toContain("Lobster");
      expect(groups[1]!.text).toMatch(/^SSam.*Lobster/);
      expect(await select(html, "[data-mine] .mine-guest .stamp")).toEqual([]);
    });

    // So "$5.00 and $32.00" under You never has to be squared with $47.68 up
    // top in someone's head.
    it("ends each person's lines with their tax and tip, adding up to their amount to the cent", async () => {
      const sum = (text: string) =>
        [...text.matchAll(/(-?)\$(\d+)\.(\d\d)/g)].reduce((n, m) => n + (m[1] ? -1 : 1) * (Number(m[2]) * 100 + Number(m[3])), 0);
      for (const [html, ids] of [[view("dani"), ["dani", "guest-sam"]], [view("gavin"), ["gavin", "guest-kim"]]] as const) {
        const groups = await select(html, "[data-mine] .mine-group");
        expect(groups).toHaveLength(ids.length);
        groups.forEach((group, i) => {
          const x = share(ids[i]!);
          expect(group.text).toContain(`Tax${money(x.taxCents)}Tip${money(x.tipCents)}`);
          expect(sum(group.text), ids[i]).toBe(x.owedCents);
        });
      }
      expect((await select(view("dani"), "[data-mine] .tax-tip")).map((r) => r.text)).toEqual([
        `Tax${money(share("dani").taxCents)}`,
        `Tip${money(share("dani").tipCents)}`,
        `Tax${money(share("guest-sam").taxCents)}`,
        `Tip${money(share("guest-sam").tipCents)}`,
      ]);
      // Alone, the bar up top already breaks the one amount down.
      expect(await select(view("theo"), "[data-mine] .tax-tip")).toEqual([]);
      expect(await select(view("theo"), "[data-you] .split-bar")).toHaveLength(1);
    });

    it("puts each person's slice of a whole-bill discount before their tax, so the lines still add up", async () => {
      const sum = (text: string) =>
        [...text.matchAll(/(-?)\$(\d+)\.(\d\d)/g)].reduce((n, m) => n + (m[1] ? -1 : 1) * (Number(m[2]) * 100 + Number(m[3])), 0);
      const off = { ...input, discountCents: 3001 };
      const discounted = splitBill(off);
      const slice = (id: string) => discounted.shares.find((x) => x.participant === id)!;
      for (const [viewer, ids] of [["dani", ["dani", "guest-sam"]], ["gavin", ["gavin", "guest-kim"]]] as const) {
        const html = renderPage({ ...confirmedBill, discountCents: 3001 }, discounted, off.items, people, viewer, { paid: [] }, NOW);
        const groups = await select(html, "[data-mine] .mine-group");
        expect(groups).toHaveLength(ids.length);
        groups.forEach((group, i) => {
          const x = slice(ids[i]!);
          expect(x.discountCents, ids[i]).toBeGreaterThan(0);
          expect(group.text).toContain(`Discount-${money(x.discountCents)}Tax${money(x.taxCents)}Tip${money(x.tipCents)}`);
          expect(sum(group.text), ids[i]).toBe(x.owedCents);
        });
      }
    });

    // The share is split off the line's total, so a dish shared with an extra
    // patty on it still adds up, with the odd cent landing on one of the two.
    it("counts a dish with add-ons at its full price in each person's lines", async () => {
      const sum = (text: string) => [...text.matchAll(/\$(\d+)\.(\d\d)/g)].reduce((n, m) => n + Number(m[1]) * 100 + Number(m[2]), 0);
      const addons = [{ label: "Extra patty", cents: 300 }, { label: "No onions", cents: 0 }];
      const burger = { id: "burger", label: "Burger", addons, cents: 1951, claimedBy: ["dani", "theo"] };
      const withBurger = { ...input, items: [...input.items, burger] };
      const split = splitBill(withBurger);
      const html = renderPage(confirmedBill, split, withBurger.items, people, "dani", { paid: [] }, NOW);

      const own = (await select(html, "[data-mine] .mine-group"))[0]!;
      expect(own.text).toContain("Burger÷2$9.76");
      expect(sum(own.text)).toBe(split.shares.find((x) => x.participant === "dani")!.owedCents);
      expect((await select(html, '#receipt li.item[data-item="burger"] .addon-line')).map((l) => l.text)).toEqual(["Extra patty+$3.00", "No onions"]);
    });

    it("breaks nothing down for someone who brought nobody", async () => {
      const html = view("theo");
      expect(await select(html, "[data-who], [data-mine] .mine-guest")).toEqual([]);
    });

    // The payer's top card is what others owe, so their own lines say whose
    // they are even with no guest to tell them apart from.
    it("heads the payer's own lines with You", async () => {
      const html = renderPage(confirmedBill, splitBill(SAIGON), SAIGON.items, participantsOf(SAIGON), "gavin", { paid: [] }, NOW);
      const groups = await select(html, "[data-mine] .mine-group");
      expect(groups).toHaveLength(1);
      expect(groups[0]!.text).toMatch(/^GYou/);
    });

    it("names a solo diner's slice of a whole-bill discount in their breakdown", async () => {
      const off = { ...input, discountCents: 3000 };
      const discounted = splitBill(off);
      const theo = discounted.shares.find((x) => x.participant === "theo")!;
      const html = renderPage({ ...confirmedBill, discountCents: 3000 }, discounted, off.items, people, "theo", { paid: [] }, NOW);

      const detail = await textOf(html, "[data-you-detail]");
      expect(detail).toContain(`Discount -${money(theo.discountCents)}`);
      expect(theo.discountCents).toBeGreaterThan(0);
      const bar = await one(html, "[data-you] .split-bar");
      expect(bar.attrs["aria-label"]).toContain(`Discount -${money(theo.discountCents)}`);
    });

    it("takes a guest who paid the payer directly off the share, and stamps them once", async () => {
      const sam = share("guest-sam");
      const settled = [{ participant: "guest-sam", cents: sam.owedCents }];
      const html = view("dani", { settled, paid: ["dani"], paidToPayer: ["guest-sam"], hasPayments: true });

      expect(await textOf(html, "[data-you-owed]")).toBe(money(share("dani").owedCents));
      expect((await one(html, "[data-you] .flow .stack")).attrs["aria-label"]).toBe("Dani");
      // On Sam's row in the top card, and not again over Sam's lines.
      expect(await select(html, "[data-mine] .mine-guest .stamp")).toEqual([]);
      expect((await one(html, '[data-person="dani"]')).attrs["aria-label"]).toContain(money(share("dani").owedCents));
      // Still listed, greyed and stamped, with no words beside the stamp.
      const rows = await select(html, "[data-who] li");
      expect(rows[1]!.attrs.class).toBe("is-off");
      expect(rows[1]!.text).toBe(`SSam付讫${money(sam.owedCents)}`);
    });

    it("stamps a guest who paid their adder for the adder, without taking anything off", async () => {
      const html = view("dani", { paidToHost: ["guest-sam"] });

      expect(await textOf(html, "[data-you-owed]")).toBe(money(share("dani").owedCents + share("guest-sam").owedCents));
      expect(await select(html, "[data-mine] .mine-guest .stamp")).toEqual([]);
      const rows = await select(html, "[data-who] li");
      expect(rows[1]!.attrs.class).toBeUndefined();
      expect(rows[1]!.text).toBe(`SSam付讫${money(share("guest-sam").owedCents)}`);
    });

    // Their share went with the member's, so they are paid the moment the
    // member is, and not once that payment is undone.
    it("stamps the guests of a member who paid in full", async () => {
      const together = share("dani").owedCents + share("guest-sam").owedCents;
      const settled = [{ participant: "dani", cents: together }];
      const html = view("dani", { settled, paid: ["dani"], hasPayments: true });

      const rows = await select(html, "[data-who] li");
      expect(rows[1]!.attrs.class).toBeUndefined();
      expect(rows[1]!.text).toBe(`SSam付讫${money(share("guest-sam").owedCents)}`);
      expect((await select(view("dani"), "[data-who] li"))[1]!.text).toBe(`SSam${money(share("guest-sam").owedCents)}`);
    });

    it("draws a forgiven share as nothing owed, with what it was struck through", async () => {
      const html = view("marcus");

      expect((await one(html, "[data-you]")).attrs.class).toContain("is-forgiven");
      expect(await textOf(html, "[data-you-owed]")).toBe("$0.00");
      expect(await textOf(html, "[data-you] .was")).toBe(money(share("marcus").owedCents));
      expect((await one(html, "[data-you] .gift-mark")).attrs["aria-label"]).toBe("Forgiven");
      expect(await select(html, "[data-pay], [data-you-detail]")).toEqual([]);

      const tile = await one(view("gavin"), '[data-person="marcus"]');
      expect(tile.attrs["aria-label"]).toContain("forgiven");
      expect(await select(view("gavin"), '[data-person="marcus"] .badge.gift')).toHaveLength(1);
      expect((await one(view("gavin"), '[data-owed="marcus"]')).attrs.class).toContain("is-forgiven");
    });

    it("stamps a share paid in full, and counts what is still out", async () => {
      const jess = share("jess").owedCents;
      const settled = [{ participant: "jess", cents: jess }, { participant: "theo", cents: 100 }];
      const html = view("jess", { settled, paid: ["jess", "theo"], hasPayments: true });

      expect((await one(html, "[data-you]")).attrs.class).toContain("is-paid");
      expect(await textOf(html, "[data-you-owed]")).toBe("$0.00");
      expect((await one(html, "[data-you] .stamp")).attrs["aria-label"]).toBe("Paid");
      expect(await textOf(html, '[data-person="jess"] .stamp')).toBe("付讫");
      expect(await select(html, '[data-person="theo"] .stamp')).toEqual([]);

      const theo = view("theo", { settled, paid: ["jess", "theo"], hasPayments: true });
      // A part payment from before paid was yes or no leaves them unpaid,
      // with no fraction to say how far along.
      expect(await textOf(theo, "[data-you-owed]")).toBe(money(share("theo").owedCents - 100));
      expect(await select(theo, "[data-you] .stamp, [data-you] .legend:not([data-you-detail])")).toEqual([]);

      // Everyone who owes something but the forgiven, less the two payments.
      // Kim, whom the payer added, owes the payer directly.
      const debtors = ["dani", "jess", "lena", "omar", "priya", "theo", "guest-kim"];
      const total = debtors.reduce((n, id) => n + share(id).owedCents, 0) + share("guest-sam").owedCents;
      const payer = view("gavin", { settled, paid: ["jess", "theo"], hasPayments: true });
      expect(await textOf(payer, "[data-you-owed]")).toBe(money(total - jess - 100));
      expect(await textOf(payer, "[data-you] .hero-cap")).toBe("to collect");
      expect(await textOf(payer, "[data-you] .legend")).toBe(`${money(total)} owed to you · ${money(jess + 100)} paid`);
      expect(await textOf(payer, '[data-go="people"] .count')).toBe(`1 of ${debtors.length} paid`);
    });

    // A guest the payer added owes the payer directly, so they sit on the
    // payer's tile but count among the people the payer collects from.
    it("puts the payer's own guest on the payer's tile, owing the payer directly", async () => {
      const html = view("gavin");
      const state = stateOf(html);

      expect(await select(html, '[data-person="gavin"] .minis .av')).toHaveLength(1);
      expect(state.owing.gavin.owedCents).toBe(share("gavin").owedCents);
      expect(state.owing["guest-kim"].owedCents).toBe(share("guest-kim").owedCents);
      expect(await textOf(html, '[data-owed="gavin"]')).toBe(money(share("gavin").owedCents));
      expect((await one(html, "[data-you] .flow .stack")).attrs["aria-label"]).toContain("Kim");
      expect(state.payerCollectsCents).toBe(Object.keys(state.owing).filter((id) => id !== "gavin").reduce((n, id) => n + state.owing[id].owedCents, 0));
      expect(await select(html, "[data-you] [data-pay]")).toEqual([]);
    });

    it("offers the viewer the payer's ways to pay, for what they have left", async () => {
      const handles = [{ method: "venmo" as const, handle: "gavin-l" }];
      const html = view("theo", { settled: [{ participant: "theo", cents: 100 }], handles });

      const link = await one(html, "[data-pay] a.pay");
      expect(link.attrs.href).toContain("venmo.com/gavin-l");
      expect(link.attrs.href).toContain(`amount=${((share("theo").owedCents - 100) / 100).toFixed(2)}`);
      expect(link.attrs).toMatchObject({ target: "_blank", rel: "noopener noreferrer" });
      expect(link.text).toBe("Venmo");
      expect(await select(view("gavin", { handles }), "[data-pay]")).toEqual([]);
      expect(await select(view("marcus", { handles }), "[data-pay]")).toEqual([]);
    });

    it("offers a button per app the payer has, and just I paid when they have none", async () => {
      const venmo = { method: "venmo" as const, handle: "gavin-l" };
      const cashapp = { method: "cashapp" as const, handle: "GavinL" };

      const both = view("theo", { handles: [venmo, cashapp] });
      expect((await select(both, "[data-pay] a.pay")).map((x) => x.text)).toEqual(["Venmo", "Cash App"]);

      const none = view("theo", { handles: [] });
      expect(await select(none, "[data-pay]")).toEqual([]);
      expect(await textOf(none, "[data-you] [data-sent] [data-pay-all]")).toBe("I paid");
    });

    it("lets someone with something left record that they paid, or say something is wrong", async () => {
      const html = view("theo", { settled: [{ participant: "theo", cents: 100 }] });

      // One tap records all of it, with no sheet to ask how much.
      const sent = await one(html, "[data-you] [data-sent] [data-pay-all]");
      expect(sent.text).toBe("I paid");
      expect(sent.attrs).not.toHaveProperty("aria-haspopup");
      // No handle on file, so no link: "I paid" stands alone.
      expect(await select(html, "[data-you] [data-pay]")).toEqual([]);
      const actions = await one(html, "[data-actions]");
      expect(actions.text).toBe("Something&#39;s wrongPaying pauses until Gavin fixes it.");
      expect(await select(html, "[data-actions] [data-ask]")).toEqual([expect.objectContaining({ attrs: expect.objectContaining({ "data-ask": "wrong" }) })]);
      expect(await select(html, "[data-confirm], [data-reopen], [data-delete-bill], [data-payments]")).toEqual([]);
    });

    it("offers nothing to record once the share is paid or forgiven", async () => {
      const jess = share("jess").owedCents;
      expect(await select(view("jess", { settled: [{ participant: "jess", cents: jess }], paid: ["jess"] }), "[data-sent]")).toEqual([]);
      expect(await select(view("marcus"), "[data-sent], [data-pay]")).toEqual([]);
    });

    it("gives the payer the payments to undo, and the bill to edit or delete, with nothing to pay", async () => {
      const jess = share("jess").owedCents;
      const sam = share("guest-sam").owedCents;
      const at = (hour: number) => `2026-10-29T${String(hour).padStart(2, "0")}:00:00.000Z`;
      const payments = [
        { id: "p-4", billId: "bill-1", participant: "guest-sam", cents: sam, recordedAt: at(12), recordedBy: "gavin" },
        { id: "p-3", billId: "bill-1", participant: "theo", cents: 200, recordedAt: at(11), recordedBy: "theo" },
        { id: "p-2", billId: "bill-1", participant: "jess", cents: jess, recordedAt: at(10), recordedBy: "jess" },
        { id: "p-1", billId: "bill-1", participant: "theo", cents: 100, recordedAt: at(9), recordedBy: "theo" },
      ];
      const settled = payments.map(({ participant, cents }) => ({ participant, cents }));
      const html = view("gavin", { payments, settled, hasPayments: true });

      expect(await select(html, "[data-sent], [data-ask=wrong], [data-confirm]")).toEqual([]);
      // One row per person who paid, in roster order. A guest who paid
      // directly is measured against their own share. Theo's two part
      // payments, from before paid was yes or no, don't cover his share.
      const rows = await select(html, "[data-payments] li");
      expect(rows.map((r) => r.text)).toEqual([`JJess${money(jess)}付讫Undo`, `SSam${money(sam)}付讫Undo`]);
      expect((await select(html, "[data-payments] [data-undo-paid]")).map((b) => [b.attrs["data-undo-paid"], b.attrs["aria-label"]])).toEqual([
        ["jess", "Undo Jess's payment"],
        ["guest-sam", "Undo Sam's payment"],
      ]);
      expect(stateOf(html).payments.map((p: any) => p.id)).toEqual(["p-4", "p-3", "p-2", "p-1"]);
      expect(await textOf(html, "[data-actions] [data-reopen]")).toBe("Edit the billPaying pauses until you confirm again.");
      expect(await textOf(html, "[data-actions] [data-delete-bill]")).toBe("Delete this bill");
      // One tap does it: no sheet asks first.
      expect(await select(html, "[data-undo-paid][aria-haspopup], [data-delete-bill][aria-haspopup]")).toEqual([]);

      // Drawn even before anyone pays, hidden, so the first payment has a place to land.
      expect((await one(view("gavin"), "[data-payments]")).attrs).toHaveProperty("hidden");
      expect(stateOf(view("dani", { payments })).payments).toEqual([]);
    });
  });

  it("is one self-contained, phone-sized page that follows the system theme", () => {
    const html = page("marcus");

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1');
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).not.toMatch(/\bsrc=|<link\b|@import/);
    // Fonts and the paper grain are inlined; the only URL is the SVG
    // namespace, which names a format and is never fetched.
    for (const url of html.match(/url\(\s*["']?[^"')]{0,12}/g) ?? []) expect(url).toMatch(/url\(\s*["']?(data:|%23)/);
    for (const link of html.match(/https?:\/\/[^\s"'<>)]*/g) ?? []) expect(link).toBe("http://www.w3.org/2000/svg");
    expect(html).toContain(CLIENT_SCRIPT);
    expect(CLIENT_SCRIPT).not.toMatch(/<\/script/i);
  });

  it("spends its font budget on the numerals and the three seal characters only", () => {
    const html = page("marcus");
    const faces = html.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    expect(faces).toHaveLength(2);
    expect(faces.join("")).toContain("unicode-range: U+2C-2E, U+30-39");
    expect(faces.join("")).toContain("unicode-range: U+4ED8, U+5B9A, U+8BAB");
    const bytes = faces.join("").length;
    expect(bytes).toBeLessThan(8_000);
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
