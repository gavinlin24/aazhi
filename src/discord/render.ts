import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APIEmbedField,
  type APIInteractionResponseCallbackData,
} from "discord-api-types/v10";
import {
  getBill,
  getLeastConfidentItemIds,
  getParticipants,
  toSplitInput,
  type BillRow,
  type Participant,
} from "../db/bills";
import { reconciles } from "../extract/claude";
import { formatCents, formatDate } from "../format";
import { splitBill } from "../money/split";
import type { LineItem, SplitResult } from "../money/types";

// Discord rejects the whole edit if any of these is exceeded, so the renderer
// trims to fit instead of trusting the receipt to be short.
const LIMITS = { title: 256, description: 4096, fieldValue: 1024, embed: 6000 };
const MAX_LABEL = 60;
const MAX_NAME = 40;

const COLOR = { draft: 0x5865f2, needsFixing: 0xf0b232, superseded: 0x80848e };

// Receipt labels and display names are other people's text; unescaped, a
// "*" in a dish name would bold half the message.
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_`~|>#[\]]/g, "\\$&");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function titleOf(bill: BillRow): string {
  const date = formatDate(bill.billDate);
  const suffix = date ? ` · ${date}` : "";
  const place = escapeMarkdown(clip(bill.place?.trim() || "Receipt", 100));
  return clip(place + suffix, LIMITS.title);
}

// Appends lines while they fit, then says how many were left out, so a long
// list degrades into "and N more" instead of a rejected edit.
function fitLines(lines: string[], budget: number, more: (n: number) => string): string {
  const kept: string[] = [];
  let length = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const left = lines.length - i - 1;
    const reserve = left > 0 ? more(left).length + 1 : 0;
    if (length + line.length + 1 + reserve > budget) {
      kept.push(more(lines.length - i));
      break;
    }
    kept.push(line);
    length += line.length + 1;
  }
  return kept.join("\n");
}

function readStatus(
  bill: BillRow,
  items: LineItem[],
  leastConfident: string[],
  payerName: string,
): { ok: boolean; text: string } {
  const check = reconciles({ items, taxCents: bill.taxCents, printedTotalCents: bill.printedTotalCents });
  if (check.ok) {
    return { ok: true, text: `Adds up: the items and tax match the printed total of ${formatCents(bill.printedTotalCents!)}.` };
  }
  if (bill.printedTotalCents === null || check.discrepancyCents === null) {
    return {
      ok: false,
      text:
        "**I couldn't read the printed total**, so I can't check this read yet. " +
        `${payerName}, enter it on the page and Confirm appears once it adds up.`,
    };
  }

  const gap = check.discrepancyCents;
  const suspects = leastConfident
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is LineItem => i !== undefined)
    .map((i) => `${escapeMarkdown(clip(i.label, MAX_LABEL))} ${formatCents(i.cents)}`);
  const pointer = suspects.length > 0 ? `Least sure about: ${suspects.join(", ")}.` : "Check the prices against the receipt.";
  return {
    ok: false,
    text:
      `**Doesn't add up yet.** The receipt's printed total is ${formatCents(bill.printedTotalCents)}, ` +
      `but the items and tax I read come to ${formatCents(bill.printedTotalCents + gap)}, ` +
      `${formatCents(Math.abs(gap))} ${gap > 0 ? "over" : "short"}. ${pointer} ` +
      `${payerName}, fix the lines on the page and Confirm appears once it adds up.`,
  };
}

function itemLine(item: LineItem, names: Map<string, string>): string {
  // Alphabetical, so a line reads the same however the claims arrived.
  const who = item.claimedBy
    .map((id) => names.get(id) ?? escapeMarkdown(id))
    .sort((a, b) => a.localeCompare(b))
    .join(", ");
  return `${escapeMarkdown(clip(item.label, MAX_LABEL))} · ${formatCents(item.cents)} · ${who || "**unclaimed**"}`;
}

function owedField(bill: BillRow, result: SplitResult, participants: Participant[], names: Map<string, string>): APIEmbedField {
  const owed = new Map(result.shares.map((s) => [s.participant, s.owedCents]));
  const lines = participants.map((p) => {
    const paid = p.id === bill.payerId ? " (paid the bill)" : "";
    return `${names.get(p.id)} ${formatCents(owed.get(p.id) ?? 0)}${paid}`;
  });
  const unclaimed = result.unclaimedCents !== 0 ? `**Unclaimed ${formatCents(result.unclaimedCents)}**` : "";
  const budget = LIMITS.fieldValue - (unclaimed ? unclaimed.length + 1 : 0);
  const people = fitLines(lines, budget, (n) => `and ${n} more`);
  return { name: "Shares so far", value: [people, unclaimed].filter(Boolean).join("\n") || "Nobody yet" };
}

function billField(bill: BillRow, result: SplitResult): APIEmbedField {
  return {
    name: "Bill",
    value:
      `Subtotal ${formatCents(result.billSubtotalCents)} · Tax ${formatCents(bill.taxCents)} · ` +
      `Tip ${formatCents(bill.tipCents)}\n**Total ${formatCents(result.distributableCents)}**`,
  };
}

function components(bill: BillRow, canConfirm: boolean): APIActionRowComponent<APIComponentInMessageActionRow>[] {
  const row: APIButtonComponent[] = [
    { type: ComponentType.Button, style: ButtonStyle.Primary, label: "Open the split", custom_id: `open:${bill.id}` },
  ];
  // The revision rides along so a Confirm tapped on a stale render is refused.
  if (canConfirm) {
    row.push({
      type: ComponentType.Button,
      style: ButtonStyle.Success,
      label: "Confirm",
      custom_id: `confirm:${bill.id}:${bill.revision}`,
    });
  }
  const rows: APIActionRowComponent<APIComponentInMessageActionRow>[] = [{ type: ComponentType.ActionRow, components: row }];
  // Lets the payer put people on the roster who have not tapped, so one person
  // can assign the whole bill at the table. Everyone sees it (a message cannot
  // hide a component from some viewers), so the handler refuses non-payers.
  // A select menu takes a whole action row; Discord allows five rows.
  if (bill.status === "draft") {
    rows.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.UserSelect,
          custom_id: `roster:${bill.id}`,
          placeholder: "Add people who were at dinner",
          min_values: 1,
          max_values: 25,
        },
      ],
    });
  }
  return rows;
}

function embedLength(embed: APIEmbed): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0) +
    (embed.footer?.text.length ?? 0)
  );
}

function superseded(bill: BillRow): APIInteractionResponseCallbackData {
  return {
    content: "",
    embeds: [
      {
        title: titleOf(bill),
        description: "A newer split in this channel replaced this one. Claim your items on the newer message.",
        color: COLOR.superseded,
      },
    ],
    components: [],
    allowed_mentions: { parse: [] },
  };
}

export function renderBill(
  bill: BillRow,
  result: SplitResult,
  items: LineItem[],
  participants: Participant[],
  leastConfident: string[] = [],
): APIInteractionResponseCallbackData {
  if (bill.status === "superseded") return superseded(bill);

  const names = new Map(participants.map((p) => [p.id, escapeMarkdown(clip(p.displayName, MAX_NAME))]));
  const payerName = names.get(bill.payerId) ?? "Payer";
  const status = readStatus(bill, items, leastConfident, payerName);

  const embed: APIEmbed = {
    title: titleOf(bill),
    color: status.ok ? COLOR.draft : COLOR.needsFixing,
    fields: [owedField(bill, result, participants, names), billField(bill, result)],
    footer: { text: "Draft: amounts change as people claim their items. Tap Open the split to claim yours." },
  };
  const head = `${status.text}\n\n`;
  const budget = Math.min(LIMITS.description, LIMITS.embed - embedLength(embed)) - head.length;
  embed.description = head + fitLines(items.map((i) => itemLine(i, names)), budget, (n) => `and ${n} more on the page`);

  return {
    content: "",
    embeds: [embed],
    components: components(bill, status.ok),
    allowed_mentions: { parse: [] },
  };
}

export async function loadBillMessage(
  db: D1Database,
  billId: string,
): Promise<{ bill: BillRow; data: APIInteractionResponseCallbackData } | null> {
  // The bill (and so the revision on Confirm) is read before the items, so a
  // render can only ever pair newer items with an older revision, which the
  // confirm check refuses, never the other way round.
  const bill = await getBill(db, billId);
  if (!bill) return null;
  const [input, participants, leastConfident] = await Promise.all([
    toSplitInput(db, billId),
    getParticipants(db, billId),
    getLeastConfidentItemIds(db, billId),
  ]);
  return { bill, data: renderBill(bill, splitBill(input), input.items, participants, leastConfident) };
}
