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

function render(b: BillRow, input: BillInput, leastConfident: string[] = []) {
  return renderBill(b, splitBill(input), input.items, participantsOf(input), leastConfident);
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
  it("renders the running amount for each participant and the unclaimed shortfall", () => {
    const data = renderBill(bill, splitBill(draftState), items, participants);
    expect(JSON.stringify(data)).toContain("$38.02"); // Marcus, draft
    expect(JSON.stringify(data)).toContain("$27.06"); // unclaimed

    const text = embedText(embedOf(data));
    expect(lineFor(text, "Marcus $")).toContain("$38.02");
    expect(lineFor(text, "Jess $")).toContain("$37.38");
    expect(lineFor(text, "Unclaimed")).toContain("$27.06");
  });

  it("titles the message with the place and the date", () => {
    expect(embedOf(render(bill, draftState)).title).toBe("Saigon Kitchen · Oct 28, 2026");
    expect(embedOf(render({ ...bill, place: null, billDate: null }, draftState)).title).toBe("Receipt");
  });

  it("lists every line with its price and who claimed it, and flags the unclaimed ones", () => {
    const text = embedText(embedOf(render(bill, draftState)));

    expect(lineFor(text, "Spring rolls")).toMatch(/\$15\.00.*Dani, Marcus, Omar/);
    expect(lineFor(text, "Banh xeo")).toMatch(/\$11\.00.*Lena, Theo/);
    expect(lineFor(text, "Thai iced tea x3")).toMatch(/\$15\.00.*unclaimed/i);
    expect(lineFor(text, "Sparkling water")).toMatch(/\$6\.00.*unclaimed/i);
    expect(lineFor(text, "Shaking beef")).not.toMatch(/unclaimed/i);
  });

  it("shows the bill subtotal, tax, tip and total", () => {
    const text = embedText(embedOf(render(bill, draftState)));

    expect(text).toContain("Subtotal $251.50");
    expect(text).toContain("Tax $22.32");
    expect(text).toContain("Tip $50.30");
    expect(text).toContain("Total $324.12");
  });

  it("marks the payer as the one who paid", () => {
    const text = embedText(embedOf(render(bill, draftState)));
    expect(lineFor(text, "Gavin $")).toMatch(/paid/i);
    expect(lineFor(text, "Marcus $")).not.toMatch(/paid/i);
  });

  it("renders no pay control while the bill is a draft", () => {
    const buttons = buttonsOf(render(bill, draftState));

    expect(buttons.map((b) => b.custom_id)).toEqual(["open:bill-1", "confirm:bill-1:7"]);
    expect(buttons.map((b) => b.label)).toEqual(["Open the split", "Confirm"]);
    expect(JSON.stringify(buttons)).not.toMatch(/pay|settle|venmo|zelle|cash/i);
  });

  it("says the read adds up when the items and tax match the printed total", () => {
    const text = embedText(embedOf(render(bill, draftState)));
    expect(text).toMatch(/adds up/i);
    expect(text).toContain("$273.82");
  });

  it("names the discrepancy and the least-confident lines instead of offering Confirm", () => {
    // The model read Garlic noodles as $82.00; the receipt says $273.82.
    const misread: BillInput = {
      ...draftState,
      items: draftState.items.map((i) => (i.id === "noodles" ? { ...i, cents: 8200 } : i)),
    };
    const data = render(bill, misread, ["noodles", "comtam"]);
    const text = embedText(embedOf(data));

    expect(buttonsOf(data).map((b) => b.custom_id)).toEqual(["open:bill-1"]);
    expect(text).toContain("$273.82"); // printed total
    expect(text).toContain("$323.82"); // items plus tax
    expect(text).toContain("$50.00"); // the gap
    expect(text).toMatch(/Garlic noodles \$82\.00/);
    expect(text).toMatch(/Com tam \$9\.50/);
    expect(text).not.toMatch(/adds up:/i);
  });

  it("says when the read comes to less than the printed total", () => {
    const short: BillInput = {
      ...draftState,
      items: draftState.items.filter((i) => i.id !== "coconut"),
    };
    const text = embedText(embedOf(render(bill, short)));
    expect(text).toMatch(/\$4\.00 (short|under|less)/i);
  });

  it("asks the payer for the total when it could not be read, and offers no Confirm", () => {
    const data = render({ ...bill, printedTotalCents: null }, draftState);
    const text = embedText(embedOf(data));

    expect(buttonsOf(data).map((b) => b.custom_id)).toEqual(["open:bill-1"]);
    expect(text).toMatch(/couldn't read the printed total/i);
    expect(text).toMatch(/enter it on the page/i);
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
    const input = withItem(
      { ...draftState, participants: [...draftState.participants, "x"] },
      { id: "odd", label: "**Chef's** _special_ `x` ~~y~~ ||z||", cents: 100, claimedBy: ["x"] },
    );
    const data = renderBill(
      { ...bill, place: "Bar *Star*" },
      splitBill(input),
      input.items,
      [...participantsOf(draftState), { billId: bill.id, id: "x", kind: "member", displayName: "__ann__", addedBy: null }],
    );
    const text = embedText(embedOf(data));

    expect(text).toContain("\\*\\*Chef's\\*\\* \\_special\\_ \\`x\\` \\~\\~y\\~\\~ \\|\\|z\\|\\|");
    expect(text).toContain("\\_\\_ann\\_\\_");
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
      ...crowd.map((id) => ({ billId: bill.id, id, kind: "member" as const, displayName: `A long display name ${id}`, addedBy: null })),
    ];

    const data = renderBill({ ...bill, printedTotalCents: null }, splitBill(input), many, people);
    const embed = embedOf(data);

    expect(embed.description!.length).toBeLessThanOrEqual(4096);
    for (const field of embed.fields ?? []) {
      expect(field.name.length).toBeLessThanOrEqual(256);
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    expect(embedLength(embed)).toBeLessThanOrEqual(6000);
    expect(embed.description).toMatch(/and \d+ more on the page/);
    expect(embedText(embed)).toMatch(/and \d+ more/);
    // The totals still show, however much of the list had to go.
    expect(embedText(embed)).toMatch(/Total \$/);
  });

  it("cuts an absurdly long label rather than the whole list", () => {
    const input = withItem(draftState, { id: "long", label: "Z".repeat(500), cents: 100, claimedBy: [] });
    const text = embedText(embedOf(render(bill, input)));
    expect(text).not.toContain("Z".repeat(200));
    expect(text).toContain("Fresh coconut");
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
