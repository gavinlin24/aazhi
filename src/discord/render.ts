import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APIInteractionResponseCallbackData,
} from "discord-api-types/v10";
import {
  getBill,
  getParticipants,
  getShares,
  toSplitInput,
  type BillRow,
  type Participant,
} from "../db/bills";
import { reconciles } from "../extract/claude";
import { formatCents, formatDate } from "../format";
import { groupByDebtor, type DebtorGroup } from "../money/debtors";
import { splitBill } from "../money/split";
import type { LineItem, Share, SplitResult } from "../money/types";

// Discord rejects the whole edit if any of these is exceeded, so the renderer
// trims to fit instead of trusting the receipt to be short.
const LIMITS = { title: 256, description: 4096, embed: 6000 };
const MAX_NAME = 40;

// The coin the page puts on the payer's avatar, standing in for "paid the
// bill" beside their name.
const PAYER_MARK = "🪙";

// The page's Ink & Paper palette: indigo for a draft, ochre for one that
// needs fixing, the vermilion of the 定 seal once confirmed, and ash when
// replaced. The left edge of the embed then matches the page it links to.
const COLOR = { draft: 0x2d4b66, needsFixing: 0x8a520f, confirmed: 0xb3302a, superseded: 0x8c8478 };

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

// A bill that doesn't add up leads with the receipt's own total, since the
// total of the dishes as read is the number in doubt. The problem itself is
// one short sentence: the gap and the lines to edit are in Open the split.
function readProblem(bill: BillRow, items: LineItem[]): { headline: string | null; line: string } | null {
  const check = reconciles({ ...bill, items });
  if (check.ok) return null;
  if (bill.printedTotalCents === null) return { headline: null, line: "⚠️ **Couldn't read the receipt total!**" };
  return {
    headline: `**Receipt total ${formatCents(bill.printedTotalCents)}**`,
    line: "⚠️ **Line items do not add up to total!**",
  };
}

function totalLine(result: SplitResult): string {
  return `**Total ${formatCents(result.distributableCents)}**`;
}

// The draft says what the bill is, whether it is ready, and what to do next.
// Who had which line and each running amount live on the page, which is one
// tap away and keeps up as people claim.
function draftSummary(
  bill: BillRow,
  result: SplitResult,
  items: LineItem[],
  participants: Participant[],
  payerName: string,
): { ok: boolean; text: string } {
  const problem = readProblem(bill, items);
  const count = participants.length === 1 ? "1 person" : `${participants.length} people`;
  // The page draws an unclaimed line with a dashed ring; ◌ is the same mark.
  const progress =
    result.unclaimedCents !== 0
      ? `◌ **${formatCents(result.unclaimedCents)} unclaimed.** Open the split to claim what you had.`
      : problem
        ? null
        : `✓ **Every dish is claimed.** ${payerName} can confirm.`;
  const lines = [
    problem?.headline ?? totalLine(result),
    `${PAYER_MARK} ${payerName} paid · ${count}`,
    problem?.line,
    progress,
  ];
  return { ok: problem === null, text: lines.filter(Boolean).join("\n") };
}

function and(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

// A guest's amount is asked of the member who brought them, so the two read
// as one row with one amount; the guest is named so the amount makes sense.
export function groupName(group: DebtorGroup, names: Map<string, string>): string {
  const own = names.get(group.debtor) ?? escapeMarkdown(group.debtor);
  return group.guests.length === 0 ? own : `${own}, including ${and(group.guests.map((g) => names.get(g.participant)!))}`;
}

// The bill message is a notice: everything a bill needs is done on the page,
// so this is its one way in.
function openButton(bill: BillRow): APIButtonComponent {
  return { type: ComponentType.Button, style: ButtonStyle.Primary, label: "Open the split", custom_id: `open:${bill.id}` };
}

function components(bill: BillRow): APIActionRowComponent<APIComponentInMessageActionRow>[] {
  const rows: APIActionRowComponent<APIComponentInMessageActionRow>[] = [
    { type: ComponentType.ActionRow, components: [openButton(bill)] },
  ];
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
          placeholder: "Add people who were there",
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
    (embed.footer?.text.length ?? 0)
  );
}

function superseded(bill: BillRow): APIInteractionResponseCallbackData {
  return {
    content: "",
    embeds: [
      {
        title: titleOf(bill),
        description: "A newer split in this channel replaced this one. Claim your dishes on the newer message.",
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

// The owe card. Amounts are the rows frozen at confirm, never a recomputation
// from the lines. One row per person who owes the payer, so the list is
// exactly what the payer is collecting: the payer's own share is owed to
// nobody. What each amount covers, paying it, and saying something is wrong
// are all on the page.
function oweCard(
  bill: BillRow,
  result: SplitResult,
  participants: Participant[],
  frozen: Share[],
  names: Map<string, string>,
): APIInteractionResponseCallbackData {
  const payer = mention(
    participants.find((p) => p.id === bill.payerId),
    names,
    names.get(bill.payerId) ?? "the person who paid",
  );
  const rows = groupByDebtor(frozen, participants, bill.payerId)
    .filter((group) => group.debtor !== bill.payerId)
    .map((group) => {
      const member = participants.find((p) => p.id === group.debtor);
      const who = group.guests.length === 0 ? mention(member, names, group.debtor) : groupName(group, names);
      return `${who} · ${groupAmount(group, names)}`;
    });

  const embed: APIEmbed = {
    title: titleOf(bill),
    color: COLOR.confirmed,
    footer: { text: "Confirmed · amounts are locked" },
  };
  const head = `${totalLine(result)}\n${PAYER_MARK} Pay ${payer} your share.\n\n`;
  const budget = Math.min(LIMITS.description, LIMITS.embed - embedLength(embed)) - head.length;
  embed.description = head + fitLines(rows, budget, (n) => `and ${n} more in Open the split`);

  return {
    content: "",
    embeds: [embed],
    components: components(bill),
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
  frozen?: Share[],
): APIInteractionResponseCallbackData {
  if (bill.status === "superseded") return superseded(bill);

  const names = new Map(participants.map((p) => [p.id, escapeMarkdown(clip(p.displayName, MAX_NAME))]));
  if (bill.status === "deleted") return deleted(bill, names);
  if (bill.status === "confirmed") return oweCard(bill, result, participants, frozen ?? result.shares, names);
  const payerName = names.get(bill.payerId) ?? "Payer";
  const summary = draftSummary(bill, result, items, participants, payerName);

  return {
    content: "",
    embeds: [
      {
        title: titleOf(bill),
        description: summary.text,
        color: summary.ok ? COLOR.draft : COLOR.needsFixing,
        footer: { text: "Draft" },
      },
    ],
    components: components(bill),
    allowed_mentions: { parse: [] },
  };
}

export async function loadBillMessage(
  db: D1Database,
  billId: string,
): Promise<{ bill: BillRow; data: APIInteractionResponseCallbackData } | null> {
  const bill = await getBill(db, billId);
  if (!bill) return null;
  const [input, participants, frozen] = await Promise.all([
    toSplitInput(db, billId),
    getParticipants(db, billId),
    bill.status === "confirmed" ? getShares(db, billId) : undefined,
  ]);
  return { bill, data: renderBill(bill, splitBill(input), input.items, participants, frozen) };
}
