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
  getShares,
  toSplitInput,
  type BillRow,
  type Participant,
} from "../db/bills";
import { reconciles } from "../extract/claude";
import { formatCents, formatDate } from "../format";
import { groupByDebtor, groupOf, type DebtorGroup } from "../money/debtors";
import { splitBill } from "../money/split";
import type { LineItem, Share, SplitResult } from "../money/types";

// Discord rejects the whole edit if any of these is exceeded, so the renderer
// trims to fit instead of trusting the receipt to be short.
const LIMITS = { title: 256, description: 4096, fieldValue: 1024, embed: 6000 };
const MAX_LABEL = 60;
const MAX_NAME = 40;
const MAX_SUMMARY = 120;

const COLOR = { draft: 0x5865f2, needsFixing: 0xf0b232, confirmed: 0x23a55a, superseded: 0x80848e };

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

function and(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

// A guest's amount is asked of the member who brought them, so the two read
// as one row with one amount; the guest is named so the amount makes sense.
function groupName(group: DebtorGroup, names: Map<string, string>): string {
  const own = names.get(group.debtor) ?? escapeMarkdown(group.debtor);
  return group.guests.length === 0 ? own : `${own}, including ${and(group.guests.map((g) => names.get(g.participant)!))}`;
}

function owedField(bill: BillRow, result: SplitResult, participants: Participant[], names: Map<string, string>): APIEmbedField {
  const groups = groupByDebtor(result.shares, participants);
  const lines = participants
    .filter((p) => p.kind === "member")
    .map((p) => {
      const group = groupOf(groups, p.id) ?? { debtor: p.id, own: undefined, guests: [], owedCents: 0 };
      const paid = p.id === bill.payerId ? " (paid the bill)" : "";
      return `${groupName(group, names)} ${formatCents(group.owedCents)}${paid}`;
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

function openButton(bill: BillRow, style: ButtonStyle.Primary | ButtonStyle.Secondary = ButtonStyle.Primary): APIButtonComponent {
  return { type: ComponentType.Button, style, label: "Open the split", custom_id: `open:${bill.id}` };
}

// Like Confirm and Reopen, everyone sees it and the handler refuses anyone
// but the payer. It only asks first; nothing is deleted from this tap.
function deleteButton(bill: BillRow): APIButtonComponent {
  return { type: ComponentType.Button, style: ButtonStyle.Danger, label: "Delete", custom_id: `delete:${bill.id}` };
}

function components(bill: BillRow, canConfirm: boolean): APIActionRowComponent<APIComponentInMessageActionRow>[] {
  const row: APIButtonComponent[] = [openButton(bill)];
  // The revision rides along so a Confirm tapped on a stale render is refused.
  if (canConfirm) {
    row.push({
      type: ComponentType.Button,
      style: ButtonStyle.Success,
      label: "Confirm",
      custom_id: `confirm:${bill.id}:${bill.revision}`,
    });
  }
  row.push(deleteButton(bill));
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

function deleted(bill: BillRow, names: Map<string, string>): APIInteractionResponseCallbackData {
  const payer = names.get(bill.payerId) ?? "The person who paid";
  return {
    content: "",
    embeds: [
      {
        title: titleOf(bill),
        description: `${payer} deleted this split, so there's nothing to claim or pay on it.`,
        color: COLOR.superseded,
      },
    ],
    components: [],
    allowed_mentions: { parse: [] },
  };
}

// A member is named by mention so the row reads as their Discord name; a
// guest has no account to mention. allowed_mentions keeps any of it from
// pinging, and embeds never ping anyway.
function mention(p: Participant | undefined, names: Map<string, string>, fallback: string): string {
  if (!p) return fallback;
  return p.kind === "member" ? `<@${p.id}>` : `${names.get(p.id)} (guest)`;
}

// "~~$44.46~~ forgiven", or "$41.10 (Sam forgiven)" when only part of a
// group was. The struck amount is what was owed before the pardon.
function groupAmount(group: DebtorGroup, names: Map<string, string>): string {
  const shares = [...(group.own ? [group.own] : []), ...group.guests];
  const forgiven = shares.filter((s) => s.pardoned);
  if (forgiven.length === 0) return formatCents(group.owedCents);
  if (forgiven.length === shares.length) return `~~${formatCents(shares.reduce((n, s) => n + s.owedCents, 0))}~~ forgiven`;
  return `${formatCents(group.owedCents)} (${and(forgiven.map((s) => names.get(s.participant)!))} forgiven)`;
}

// "Spring rolls (1/3), Bun bo Hue": what a person's amount covers, with the
// share of any line they split. Cut while still raw text and escaped after,
// so the cut can never land between a backslash and the character it guards.
function coveredBy(participant: string, items: LineItem[]): string {
  const lines = items.flatMap((item) => {
    if (!item.claimedBy.includes(participant)) return [];
    const label = clip(item.label, MAX_LABEL);
    return [item.claimedBy.length > 1 ? `${label} (1/${item.claimedBy.length})` : label];
  });
  return lines.length > 0 ? escapeMarkdown(clip(lines.join(", "), MAX_SUMMARY)) : "nothing claimed";
}

// The owe card. Amounts are the rows frozen at confirm, never a recomputation
// from the lines. Its buttons are shared by everyone who can see the message,
// so each one answers the tapper privately about their own share.
function oweCard(
  bill: BillRow,
  result: SplitResult,
  items: LineItem[],
  participants: Participant[],
  frozen: Share[],
  names: Map<string, string>,
): APIInteractionResponseCallbackData {
  const payerName = names.get(bill.payerId) ?? "the person who paid";
  const payer = mention(
    participants.find((p) => p.id === bill.payerId),
    names,
    payerName,
  );
  const rows = groupByDebtor(frozen, participants).map((group) => {
    const member = participants.find((p) => p.id === group.debtor);
    const who = group.guests.length === 0 ? mention(member, names, group.debtor) : groupName(group, names);
    const paid = group.debtor === bill.payerId ? " (paid the bill)" : "";
    const covers = [
      ...(group.own ? [coveredBy(group.own.participant, items)] : []),
      ...group.guests.map((g) => `${names.get(g.participant)}: ${coveredBy(g.participant, items)}`),
    ].join("; ");
    return `${who} · ${groupAmount(group, names)}${paid} · ${covers}`;
  });

  const embed: APIEmbed = {
    title: titleOf(bill),
    color: COLOR.confirmed,
    fields: [billField(bill, result)],
    footer: {
      text:
        "These amounts are locked. Charged for something that isn't yours? Tap That's not mine and paying " +
        `pauses until ${payerName} fixes it.`,
    },
  };
  const head =
    `**Confirmed.** Pay ${payer} your share. **Pay my share** has your amount filled in, **I paid** records it ` +
    "once you've sent it, and **Show my math** shows how it was worked out.\n\n";
  const budget = Math.min(LIMITS.description, LIMITS.embed - embedLength(embed)) - head.length;
  embed.description = head + fitLines(rows, budget, (n) => `and ${n} more on the page`);

  const button = (
    style: ButtonStyle.Success | ButtonStyle.Primary | ButtonStyle.Secondary,
    label: string,
    prefix: string,
  ): APIButtonComponent => ({
    type: ComponentType.Button,
    style,
    label,
    custom_id: `${prefix}:${bill.id}`,
  });
  return {
    content: "",
    embeds: [embed],
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          button(ButtonStyle.Success, "Pay my share", "pay"),
          button(ButtonStyle.Primary, "I paid", "paid"),
          button(ButtonStyle.Secondary, "Show my math", "math"),
          button(ButtonStyle.Secondary, "That's not mine", "notmine"),
        ],
      },
      // Undo, Reopen and Delete are the payer's, refused for anyone else like Confirm.
      {
        type: ComponentType.ActionRow,
        components: [
          openButton(bill, ButtonStyle.Secondary),
          button(ButtonStyle.Secondary, "Undo a payment", "undo"),
          button(ButtonStyle.Secondary, "Reopen", "reopen"),
          deleteButton(bill),
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

// `frozen` is the confirmed bill's stored share rows; without them a
// confirmed render falls back to the split the lines give, which is the same
// thing unless the lines were changed under a frozen bill.
export function renderBill(
  bill: BillRow,
  result: SplitResult,
  items: LineItem[],
  participants: Participant[],
  leastConfident: string[] = [],
  frozen?: Share[],
): APIInteractionResponseCallbackData {
  if (bill.status === "superseded") return superseded(bill);

  const names = new Map(participants.map((p) => [p.id, escapeMarkdown(clip(p.displayName, MAX_NAME))]));
  if (bill.status === "deleted") return deleted(bill, names);
  if (bill.status === "confirmed") return oweCard(bill, result, items, participants, frozen ?? result.shares, names);
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
  const [input, participants, leastConfident, frozen] = await Promise.all([
    toSplitInput(db, billId),
    getParticipants(db, billId),
    getLeastConfidentItemIds(db, billId),
    bill.status === "confirmed" ? getShares(db, billId) : undefined,
  ]);
  return { bill, data: renderBill(bill, splitBill(input), input.items, participants, leastConfident, frozen) };
}
