import { describe, expect, it } from "vitest";
import type { BillRow, Participant } from "../../src/db/bills";
import { renderBill } from "../../src/discord/render";
import { splitBill } from "../../src/money/split";
import type { BillInput, LineItem } from "../../src/money/types";
import { SAIGON, withItem, withUnclaimed } from "../fixtures/saigon";

const NAMES: Record<string, string> = {
  dani: "Dani",
  gavin: "Gavin",
  jess: "Jess",
  lena: "Lena",
  marcus: "Marcus",
  omar: "Omar",
  priya: "Priya",
  theo: "Theo",
};

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
    displayName: NAMES[id] ?? id,
    addedBy: null,
  }));
}

// Tea and water unclaimed: the spec's mid-dinner draft.
const draftState = withUnclaimed(SAIGON, ["tea", "water"]);
const items = draftState.items;
const participants = participantsOf(draftState);

type Embed = {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string }[];
  footer?: { text: string };
};
type Button = { type: number; custom_id?: string; label?: string; placeholder?: string; min_values?: number; max_values?: number };

function render(b: BillRow, input: BillInput) {
  return renderBill(b, splitBill(input), input.items, participantsOf(input));
}

function embedOf(data: ReturnType<typeof renderBill>): Embed {
  expect(data.embeds).toHaveLength(1);
  return data.embeds![0] as Embed;
}

function componentsOf(data: ReturnType<typeof renderBill>): Button[] {
  return ((data.components ?? []) as { components: Button[] }[]).flatMap((row) => row.components);
}

function buttonsOf(data: ReturnType<typeof renderBill>): Button[] {
  return componentsOf(data).filter((c) => c.type === 2);
}

function embedText(e: Embed): string {
  return [e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value]), e.footer?.text]
    .filter(Boolean)
    .join("\n");
}

function embedLength(e: Embed): number {
  return (
    (e.title ?? "").length +
    (e.description ?? "").length +
    (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0) +
    (e.footer?.text ?? "").length
  );
}

function lineFor(text: string, label: string): string {
  const line = text.split("\n").find((l) => l.includes(label));
  expect(line, `no line mentions ${label}`).toBeDefined();
  return line!;
}

describe("renderBill", () => {
  it("says the total, who paid, how many are on it and how much is still unclaimed", () => {
    const embed = embedOf(render(bill, draftState));

    expect(embed.description!.split("\n")).toEqual([
      "**Total $324.12**",
      "🪙 Gavin paid · 8 people",
      "◌ **$27.06 unclaimed.** Open the split to claim what you had.",
    ]);
    expect(embed.footer?.text).toBe("Draft");
    expect(embed.color).toBe(0x2d4b66);
  });

  it("takes a whole-bill discount off the total, and counts it in the receipt check", () => {
    const discounted = { ...draftState, discountCents: 2515 };
    const adds = embedOf(render({ ...bill, discountCents: 2515, printedTotalCents: 27382 - 2515 }, discounted));
    expect(adds.description!.split("\n")[0]).toBe("**Total $298.97**");

    // The receipt printed the discount but the bill has none yet.
    const missed = embedOf(render({ ...bill, printedTotalCents: 27382 - 2515 }, draftState));
    expect(missed.description).toContain("Line items do not add up to total!");
  });

  it("titles the message with the place and the date", () => {
    expect(embedOf(render(bill, draftState)).title).toBe("Saigon Kitchen · Oct 28, 2026");
    expect(embedOf(render({ ...bill, place: null, billDate: null }, draftState)).title).toBe("Receipt");
  });

  // The page has every line, who had it and each running amount, so the
  // message repeats none of it.
  it("leaves the lines, the breakdown and each person's running amount to the page", () => {
    const embed = embedOf(render(bill, draftState));
    const text = embedText(embed);

    expect(embed.fields ?? []).toEqual([]);
    expect(text).not.toMatch(/Spring rolls|Shaking beef/);
    expect(text).not.toMatch(/Marcus|Jess/);
    expect(text).not.toMatch(/\$38\.02|\$37\.38/);
    expect(text).not.toMatch(/Subtotal|Tax|Tip/);
  });

  it("says when every line is claimed and the payer can confirm", () => {
    const data = render(bill, SAIGON);
    const text = embedText(embedOf(data));

    expect(text).toContain("✓ **Every dish is claimed.** Gavin can confirm.");
    expect(text).not.toMatch(/unclaimed/);
    // Confirming is done on the page, so the message still has only its one button.
    expect(buttonsOf(data).map((b) => b.custom_id)).toEqual(["open:bill-1"]);
  });

  it("counts guests among the people on the bill", () => {
    const guest: Participant = { billId: bill.id, id: "sam", kind: "guest", displayName: "Sam", addedBy: "dani" };
    const input = { ...draftState, participants: [...draftState.participants, "sam"] };
    const data = renderBill(bill, splitBill(input), input.items, [...participantsOf(draftState), guest]);
    expect(embedText(embedOf(data))).toContain("🪙 Gavin paid · 9 people");
  });

  // A reopened bill keeps its pardons, so a bare $0.00 would read as a claiming mistake.
  it("never shows a forgiven share as a bare $0.00 in the draft", () => {
    const text = embedText(embedOf(render(bill, { ...draftState, pardoned: ["marcus"] })));
    expect(text).not.toContain("$0.00");
  });

  it("offers only Open the split while the bill is a draft, since confirming and deleting happen on the page", () => {
    const buttons = buttonsOf(render(bill, draftState));

    expect(buttons.map((b) => b.custom_id)).toEqual(["open:bill-1"]);
    expect(buttons.map((b) => b.label)).toEqual(["Open the split"]);
    expect(JSON.stringify(buttons)).not.toMatch(/pay|settle|venmo|zelle|cash/i);
  });

  it("raises no problem when the items and tax match the printed total", () => {
    const text = embedText(embedOf(render(bill, draftState)));
    expect(text).not.toMatch(/⚠️|add up|receipt total/i);
  });

  it("leads with the receipt's total and says only that the lines do not add up", () => {
    // The model read Garlic noodles as $82.00; the receipt says $273.82.
    const misread: BillInput = {
      ...draftState,
      items: draftState.items.map((i) => (i.id === "noodles" ? { ...i, cents: 8200 } : i)),
    };
    const data = render(bill, misread);
    const embed = embedOf(data);

    expect(buttonsOf(data).map((b) => b.custom_id)).toEqual(["open:bill-1"]);
    expect(embed.description!.split("\n")).toEqual([
      "**Receipt total $273.82**",
      "🪙 Gavin paid · 8 people",
      "⚠️ **Line items do not add up to total!**",
      // Claiming goes on while the payer fixes the lines.
      "◌ **$26.06 unclaimed.** Open the split to claim what you had.",
    ]);
    expect(embed.color).toBe(0x8a520f);
  });

  it("says the same when the lines come to less than the receipt", () => {
    const short: BillInput = { ...SAIGON, items: SAIGON.items.filter((i) => i.id !== "coconut") };
    expect(embedOf(render(bill, short)).description!.split("\n")).toEqual([
      "**Receipt total $273.82**",
      "🪙 Gavin paid · 8 people",
      "⚠️ **Line items do not add up to total!**",
    ]);
  });

  it("says the receipt total could not be read", () => {
    const data = render({ ...bill, printedTotalCents: null }, draftState);

    expect(buttonsOf(data).map((b) => b.custom_id)).toEqual(["open:bill-1"]);
    expect(embedOf(data).description!.split("\n")).toEqual([
      "**Total $324.12**",
      "🪙 Gavin paid · 8 people",
      "⚠️ **Couldn't read the receipt total!**",
      "◌ **$27.06 unclaimed.** Open the split to claim what you had.",
    ]);
  });

  it("offers the payer a picker to add people who were at dinner, on a row of its own", () => {
    const data = render(bill, draftState);
    const rows = data.components as { type: number; components: Button[] }[];

    const pickers = componentsOf(data).filter((c) => c.type === 5);
    expect(pickers).toEqual([
      {
        type: 5,
        custom_id: "roster:bill-1",
        placeholder: expect.stringMatching(/at dinner/i),
        min_values: 1,
        max_values: 25,
      },
    ]);
    const pickerRow = rows.find((r) => r.components.some((c) => c.type === 5))!;
    expect(pickerRow.components).toHaveLength(1);
    expect(rows.length).toBeLessThanOrEqual(5);
    expect(rows.every((r) => r.type === 1)).toBe(true);
  });

  it("offers no roster picker once the bill is no longer a draft", () => {
    const confirmed = render({ ...bill, status: "confirmed" }, SAIGON);
    expect(componentsOf(confirmed).some((c) => c.type === 5)).toBe(false);
  });

  it("never pings anyone", () => {
    expect(render(bill, draftState).allowed_mentions).toEqual({ parse: [] });
  });

  it("escapes Discord markdown in text that came from the receipt or from people", () => {
    const input = { ...draftState, participants: [...draftState.participants, "x"], payer: "x" };
    const data = renderBill(
      { ...bill, place: "Bar *Star*", payerId: "x" },
      splitBill(input),
      input.items,
      [...participantsOf(draftState), { billId: bill.id, id: "x", kind: "member", displayName: "__ann__", addedBy: null }],
    );
    const text = embedText(embedOf(data));

    expect(text).toContain("\\_\\_ann\\_\\_ paid");
    expect(embedOf(data).title).toBe("Bar \\*Star\\* · Oct 28, 2026");
  });

  it("stays inside Discord's embed limits on a very long receipt and points at the page for the rest", () => {
    const many: LineItem[] = Array.from({ length: 300 }, (_, i) => ({
      id: `i${i}`,
      label: `Item ${i} with a long and quite descriptive name from the kitchen printer`,
      cents: 1000 + i,
      claimedBy: i % 3 === 0 ? [] : ["dani", "gavin", "jess"],
    }));
    const crowd = Array.from({ length: 120 }, (_, i) => `person-${String(i).padStart(3, "0")}`);
    const input: BillInput = { ...SAIGON, items: many, participants: [...SAIGON.participants, ...crowd] };
    const people: Participant[] = [
      ...participantsOf(SAIGON),
      ...crowd.map((id) => ({ billId: bill.id, id, kind: "guest" as const, displayName: `A long display name ${id}`, addedBy: "gavin" })),
    ];
    const withinLimits = (embed: Embed) => {
      expect(embed.title!.length).toBeLessThanOrEqual(256);
      expect(embed.description!.length).toBeLessThanOrEqual(4096);
      expect(embedLength(embed)).toBeLessThanOrEqual(6000);
    };

    const draft = embedOf(renderBill({ ...bill, place: "P".repeat(400) }, splitBill(input), many, people));
    withinLimits(draft);
    expect(draft.description).toMatch(/^\*\*Receipt total \$/);

    // The guests the payer added owe the payer directly, one row each.
    const confirmed = embedOf(
      renderBill({ ...bill, status: "confirmed" }, splitBill(input), many, people, splitBill(input).shares),
    );
    withinLimits(confirmed);
    expect(confirmed.description).toMatch(/and \d+ more in Open the split$/);
    // The total still shows, however much of the list had to go.
    expect(confirmed.description).toMatch(/^\*\*Total \$/);
  });

  it("shows what each person owes the payer once confirmed, and one button that leads to the page", () => {
    const confirmedBill: BillRow = { ...bill, status: "confirmed", confirmedAt: "2026-10-28T22:00:00.000Z" };
    // The frozen rows, not a fresh split: Marcus's row says $40.00 here even
    // though the lines would give him $44.46 today.
    const frozen = splitBill(SAIGON).shares.map((s) => (s.participant === "marcus" ? { ...s, owedCents: 4000 } : s));
    const data = renderBill(confirmedBill, splitBill(SAIGON), SAIGON.items, participantsOf(SAIGON), frozen);
    const embed = embedOf(data);
    const text = embedText(embed);

    expect(embed.description!.split("\n").slice(0, 3)).toEqual(["**Total $324.12**", "🪙 Pay <@gavin> your share.", ""]);
    expect(embed.footer?.text).toBe("Confirmed · amounts are locked");
    expect(lineFor(text, "<@marcus>")).toBe("<@marcus> · $40.00");
    expect(text).not.toContain("$44.46");
    expect(lineFor(text, "<@priya>")).toBe("<@priya> · $50.91");
    // The payer's own share is owed to nobody, so it has no row.
    expect(text).not.toMatch(/<@gavin> ·/);
    expect(text).not.toContain("$48.33");
    expect(buttonsOf(data).map((b) => b.custom_id)).toEqual(["open:bill-1"]);
    expect(buttonsOf(data).map((b) => b.label)).toEqual(["Open the split"]);
    expect(data.components).toHaveLength(1);
    expect(data.allowed_mentions).toEqual({ parse: [] });
  });

  it("tells people a deleted bill was deleted and strips its buttons", () => {
    const data = render({ ...bill, status: "deleted" }, SAIGON);
    const embed = embedOf(data);

    expect(data.components).toEqual([]);
    expect(embed.title).toBe("Saigon Kitchen · Oct 28, 2026");
    expect(embedText(embed)).toMatch(/Gavin deleted this split/);
    expect(embedText(embed)).not.toContain("$44.46");
    expect(data.allowed_mentions).toEqual({ parse: [] });
  });

  it("tells people a superseded bill was replaced and strips its buttons", () => {
    const data = render({ ...bill, status: "superseded" }, draftState);
    const embed = embedOf(data);

    expect(data.components).toEqual([]);
    expect(embed.title).toBe("Saigon Kitchen · Oct 28, 2026");
    expect(embedText(embed)).toMatch(/newer split.*replaced/i);
    expect(embedText(embed)).not.toContain("$38.02");
    expect(data.allowed_mentions).toEqual({ parse: [] });
  });
});
