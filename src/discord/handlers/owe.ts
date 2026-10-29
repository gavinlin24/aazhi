import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ButtonStyle,
  ComponentType,
  InteractionType,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIInteraction,
} from "discord-api-types/v10";
import {
  BillNotConfirmedError,
  getBill,
  getBillItems,
  getParticipants,
  getSettled,
  getShares,
  reopenBill,
  type AmountChange,
  type BillRow,
  type Participant,
} from "../../db/bills";
import { getPaymentHandles, setPaymentHandle } from "../../db/handles";
import type { Env } from "../../env";
import { formatCents, formatDate } from "../../format";
import { debtorOf, groupByDebtor, groupOf, owedAfterPardon, type DebtorGroup } from "../../money/debtors";
import { itemPieces } from "../../money/split";
import type { Cents, LineItem, Share } from "../../money/types";
import { describeHandle, HANDLE_RULES, METHOD_NAMES, normalizeHandle, PAY_METHODS, payLink, type PayMethod } from "../../web/paylink";
import type { InteractionHandler } from "../interactions";
import { invokerOf } from "../members";
import { escapeMarkdown, groupName } from "../render";
import { ephemeral } from "../rest";
import {
  announcement,
  list,
  nameOf,
  NOT_FOUND,
  NOT_SUPPORTED,
  outLoud,
  parseCustomId,
  privately,
  refreshMessage,
  STATUS_REFUSAL,
} from "./lifecycle";

const NOT_ON_BILL = "You're not on this bill, so there's nothing here for you to pay or check.";
export const NO_SHARE = "You have no share on this bill, so there's nothing for you to pay.";
// Discord refuses an ephemeral reply over 2000 characters, and the diner then
// sees only "This interaction failed".
const MAX_CONTENT = 2000;
const MAX_LABEL = 60;
const MAX_BILL_NAME = 80;
const MAX_NOTE = 60;
const MAX_NAME = 40;

// By code point, so a cut never splits an emoji into a lone surrogate.
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

// Clipped before anything escapes it, so a cut never strands a backslash.
export function billName(bill: BillRow): string {
  const date = formatDate(bill.billDate);
  return `${clip(bill.place?.trim() || "dinner", MAX_BILL_NAME)}${date ? `, ${date}` : ""}`;
}

function moreRow(rest: { piece: number }[]): string {
  const cents = rest.reduce((sum, { piece }) => sum + piece, 0);
  return `${rest.length} more lines: ${formatCents(cents)} (all of them are on the page)`;
}

// Item lines are added while they fit the budget; whatever does not is folded
// into one row carrying its total, so the listed pieces still add up to the
// person's subtotal. Each step keeps room for the row that would fold the
// rest, so the fold always fits when it comes.
function fitItemLines(rows: { text: string; piece: number }[], budget: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < rows.length; i++) {
    const rest = rows.slice(i + 1);
    const reserve = rest.length > 0 ? moreRow(rest).length + 1 : 0;
    if (used + rows[i]!.text.length + 1 + reserve > budget) {
      kept.push(moreRow(rows.slice(i)));
      break;
    }
    kept.push(rows[i]!.text);
    used += rows[i]!.text.length + 1;
  }
  return kept;
}

interface ItemRow {
  text: string;
  piece: number;
}

function itemRows(participant: string, items: LineItem[]): ItemRow[] {
  return items.flatMap((item) => {
    const piece = itemPieces(item).get(participant);
    if (piece === undefined) return [];
    const label = escapeMarkdown(clip(item.label, MAX_LABEL));
    const ways = item.claimedBy.length;
    const text =
      ways > 1 ? `${label}: ${formatCents(item.cents)} split ${ways} ways = ${formatCents(piece)}` : `${label}: ${formatCents(piece)}`;
    return [{ text, piece }];
  });
}

interface MathBlock {
  head: string[];
  rows: ItemRow[];
  tail: string[];
}

function lineCost(lines: string[]): number {
  return lines.reduce((n, line) => n + line.length + 1, 0);
}

export interface GuestMath {
  name: string;
  share: Share;
  // What the guest paid the payer directly, which is off the person's total.
  paidDirectlyCents?: Cents;
}

// The person's items, their tax and tip slices, and the fraction of the bill
// subtotal that produced them. The fraction stays integer cents over integer
// cents; a percentage would be a rounded float standing in for the real ratio.
// Every amount shown is a frozen share figure, so the lines sum to what the
// card says the person owes. A guest's lines come after, in a block of their
// own, since the person answers for them but did not eat them.
export function renderMath(
  share: Share,
  items: LineItem[],
  bill: BillRow,
  extra: { guests?: GuestMath[]; payer?: string } = {},
): string {
  const guests = extra.guests ?? [];
  const payer = extra.payer ?? "the person who paid";
  const billSubtotal = items.reduce((sum, item) => sum + item.cents, 0);
  const sum = (s: Share) =>
    `**${formatCents(s.subtotalCents)} + ${formatCents(s.taxCents)} + ${formatCents(s.tipCents)} = ${formatCents(s.owedCents)}**`;
  // The slices are the frozen, rounded cents, so against the exact product
  // they are approximate; only the closing sum is exact.
  const slices = (s: Share, whose: string) => {
    const ratio = `${s.subtotalCents}/${billSubtotal}`;
    return billSubtotal === 0
      ? [`${whose} items: ${formatCents(s.subtotalCents)}. The lines add up to $0.00, so there was no tax or tip to share.`, sum(s)]
      : [
          `${whose} items: **${formatCents(s.subtotalCents)}**, which is ${ratio} of the ${formatCents(billSubtotal)} bill subtotal.`,
          `Tax: ${formatCents(bill.taxCents)} × ${ratio} ≈ ${formatCents(s.taxCents)}`,
          `Tip: ${formatCents(bill.tipCents)} × ${ratio} ≈ ${formatCents(s.tipCents)}`,
          sum(s),
        ];
  };

  const ownTail = slices(share, "Your");
  if (billSubtotal !== 0) ownTail.push("Tax and tip are rounded to the cent so that everyone's shares add up to the bill exactly.");
  if (share.participant === bill.payerId) ownTail.push("You paid the bill, so this is your own part of it.");
  if (share.pardoned) ownTail.push(`**${payer} forgave your ${formatCents(share.owedCents)}**, so you don't owe it.`);
  const own: MathBlock = { head: [`**Your math for ${escapeMarkdown(billName(bill))}**`], rows: itemRows(share.participant, items), tail: ownTail };

  const guestBlock = (g: GuestMath, full: boolean): MathBlock => {
    const name = escapeMarkdown(g.name);
    const tail = full ? slices(g.share, `${name}'s`) : [sum(g.share)];
    if (g.share.pardoned) tail.push(`${payer} forgave ${name}'s ${formatCents(g.share.owedCents)}, so you don't owe it.`);
    if (g.paidDirectlyCents) tail.push(`${name} paid ${payer} ${formatCents(g.paidDirectlyCents)} directly, so that's off your total.`);
    return { head: [`**${name}, your guest**`], rows: full ? itemRows(g.share.participant, items) : [], tail };
  };
  // Not clamped at zero, so the sum is always the amount Pay my share asks for.
  const guestOwes = (g: GuestMath) => owedAfterPardon(g.share) - (g.paidDirectlyCents ?? 0);
  const closing =
    guests.length === 0
      ? []
      : [
          `**In all: ${[
            `${formatCents(owedAfterPardon(share))} for you`,
            ...guests.map((g) => `${formatCents(guestOwes(g))} for ${escapeMarkdown(g.name)}`),
          ].join(" + ")} = ${formatCents(owedAfterPardon(share) + guests.reduce((n, g) => n + guestOwes(g), 0))}**`,
        ];

  // A long guest list could crowd out everything else, so past the limit each
  // guest shrinks to the sum that matters rather than the reply failing.
  const fixedCost = (blocks: MathBlock[]) =>
    blocks.reduce((n, b) => n + lineCost(b.head) + lineCost(b.tail) + (b.rows.length > 0 ? moreRow(b.rows).length + 1 : 0), 0) +
    lineCost(closing);
  let blocks = [own, ...guests.map((g) => guestBlock(g, true))];
  if (fixedCost(blocks) > MAX_CONTENT) blocks = [own, ...guests.map((g) => guestBlock(g, false))];

  // Each block gets what is left after every block's fixed lines, keeping room
  // for the folded row each later block might need.
  let budget = MAX_CONTENT - blocks.reduce((n, b) => n + lineCost(b.head) + lineCost(b.tail), 0) - lineCost(closing);
  const lines: string[] = [];
  blocks.forEach((block, i) => {
    const reserve = blocks.slice(i + 1).reduce((n, b) => n + (b.rows.length > 0 ? moreRow(b.rows).length + 1 : 0), 0);
    const kept = fitItemLines(block.rows, budget - reserve);
    budget -= lineCost(kept);
    lines.push(...block.head, ...kept, ...block.tail);
  });
  return [...lines, ...closing].join("\n");
}

// What forgiving a share, or taking that back, is announced as. The amount
// named is the one share that changed; what follows is what the member who
// answers for it owes now, with any guests named the way the owe card names
// the pair, since that row is where the number shows. Null when the share is
// not on the bill.
export function pardonNotice(
  bill: BillRow,
  participants: Participant[],
  shares: Share[],
  participantId: string,
  pardoned: boolean,
): string | null {
  const target = participants.find((p) => p.id === participantId);
  const share = shares.find((s) => s.participant === participantId);
  const group = target && groupOf(groupByDebtor(shares, participants, bill.payerId), debtorOf(target, bill.payerId));
  if (!target || !share || !group) return null;

  const names = new Map(participants.map((p) => [p.id, escapeMarkdown(clip(p.displayName, MAX_NAME))]));
  const payer = names.get(bill.payerId) ?? "The person who paid";
  const whose = `${names.get(target.id)}'s ${formatCents(share.owedCents)} for ${escapeMarkdown(billName(bill))}`;
  // "Dani, including Sam" is an aside mid-sentence, so it closes with a comma.
  const who = groupName(group, names) + (group.guests.length > 0 ? "," : "");
  if (pardoned) {
    return clip(`${payer} forgave ${whose}, so ${who} owes ${group.owedCents === 0 ? "nothing" : formatCents(group.owedCents)}.`, MAX_CONTENT);
  }
  // "Again" only when the row is back to what it was before any pardon.
  const stillForgiven = [group.own, ...group.guests].some((s) => s?.pardoned);
  return clip(`${payer} took back forgiving ${whose}, so ${who} owes ${formatCents(group.owedCents)}${stillForgiven ? "" : " again"}.`, MAX_CONTENT);
}

// What a guest paying the payer directly, or that being taken back, is
// announced as, worded like I paid and Undo a payment so the channel reads
// one way. `leftCents` is what the person answering for the guest has left.
export function guestPaidNotice(
  bill: BillRow,
  participants: Participant[],
  guestId: string,
  cents: Cents,
  paid: boolean,
  leftCents: Cents,
): string | null {
  const guest = participants.find((p) => p.id === guestId);
  if (!guest) return null;
  const debtor = debtorOf(guest, bill.payerId);
  const payer = nameOf(participants, bill.payerId);
  const who = nameOf(participants, guest.id);
  const answers = nameOf(participants, debtor);
  const forBill = escapeMarkdown(billName(bill));
  const after = leftCents > 0 ? `${answers} has ${formatCents(leftCents)} left to pay.` : `${answers} is all paid up.`;
  if (!paid) return clip(`${payer} removed ${who}'s ${formatCents(cents)} payment on ${forBill}. ${after}`, MAX_CONTENT);
  const directly = debtor === guest.id ? "" : " directly";
  return clip(`${who} paid ${payer} ${formatCents(cents)}${directly} for ${forBill}. ${after}`, MAX_CONTENT);
}

export function paidUp(payer: string, settledCents: number): string {
  return `You're all paid up on this bill: you've paid ${payer} ${formatCents(settledCents)}.`;
}

export interface DinerTap {
  bill: BillRow;
  participants: Participant[];
  who: string;
}

// The owe card's buttons are on one message everyone sees, so every tap is
// about the tapper: it has to be someone on the bill, and the answer is theirs.
export async function dinerTap(
  body: APIInteraction,
  env: Env,
  prefix: string,
  ids = parseCustomId(body, prefix, false),
): Promise<DinerTap | Response> {
  const who = invokerOf(body);
  if (!ids || !who) return privately(NOT_SUPPORTED);
  const bill = await getBill(env.DB, ids.billId);
  if (!bill) return privately(NOT_FOUND);
  if (bill.status === "superseded" || bill.status === "deleted") return privately(STATUS_REFUSAL[bill.status]);
  const participants = await getParticipants(env.DB, bill.id);
  if (!participants.some((p) => p.id === who.id && p.kind === "member")) return privately(NOT_ON_BILL);
  return { bill, participants, who: who.id };
}

// A tap on pay controls that should already be gone: the card is behind, so
// it is brought up to date while the person is told why.
export function notConfirmed(tap: DinerTap, env: Env, ctx: ExecutionContext, draft: string): Response {
  if (tap.bill.status !== "draft") return privately(STATUS_REFUSAL[tap.bill.status]);
  refreshMessage(tap.bill, env, ctx);
  return privately(draft);
}

export function paused(tap: DinerTap): string {
  return `This bill was reopened, so paying is paused until ${nameOf(tap.participants, tap.bill.payerId)} confirms it again.`;
}

// Everything the tapper answers for: their own share and their guests'.
async function frozenGroup(env: Env, tap: DinerTap): Promise<DebtorGroup | undefined> {
  return groupOf(groupByDebtor(await getShares(env.DB, tap.bill.id), tap.participants, tap.bill.payerId), tap.who);
}

// What each person on the bill has paid toward it, by participant.
async function paidSoFar(env: Env, tap: DinerTap): Promise<Map<string, Cents>> {
  return new Map((await getSettled(env.DB, tap.bill.id)).map((s) => [s.participant, s.cents]));
}

function methodList(methods: PayMethod[]): string {
  return list(methods.map((m) => METHOD_NAMES[m]));
}

function guestNames(tap: DinerTap, shares: Share[]): string[] {
  return shares.map((s) => nameOf(tap.participants, s.participant));
}

function paidDirectlyNote(tap: DinerTap, direct: Share[], payer: string): string {
  if (direct.length === 0) return "";
  return ` ${list(guestNames(tap, direct))} paid ${payer} directly, so ${direct.length === 1 ? "that share is" : "those shares are"} off your total.`;
}

// Who the amount is for, when it is more than the tapper's own share or less.
// `direct` are the guests who paid the payer themselves.
function covers(tap: DinerTap, group: DebtorGroup, payer: string, direct: Share[]): string {
  const owing = guestNames(tap, group.guests.filter((s) => !s.pardoned && !direct.includes(s)));
  const forgiven = guestNames(tap, group.guests.filter((s) => s.pardoned));
  const parts: string[] = [];
  if (owing.length > 0) {
    parts.push(
      group.own?.pardoned
        ? `It's for ${list(owing)}, since ${payer} forgave your own share.`
        : `That includes ${list(owing.map((n) => `${n}'s`))} share.`,
    );
  }
  if (forgiven.length > 0) parts.push(`${payer} forgave ${list(forgiven.map((n) => `${n}'s`))} share.`);
  return parts.map((p) => ` ${p}`).join("") + paidDirectlyNote(tap, direct, payer);
}

const PAYWITH_HINT = "run `/paywith` to add your Venmo, Cash App or Zelle, and every bill you pay for will offer it";

// A guest the payer added owes the payer directly, so the payer's group is
// only ever their own share.
async function payerReply(env: Env, tap: DinerTap, group: DebtorGroup | undefined): Promise<Response> {
  const handles = await getPaymentHandles(env.DB, tap.who);
  const own = group ? ` Your own part of it was ${formatCents(group.owedCents)}.` : "";
  const how =
    handles.length === 0
      ? ` Nobody can pay you by link yet: ${PAYWITH_HINT}.`
      : ` People who tap **Pay my share** are offered your ${methodList(handles.map((h) => h.method))}.`;
  return privately(`You paid the bill, so there's nothing for you to pay.${own}${how}`);
}

export const payTap: InteractionHandler = async (body, env, ctx) => {
  const tap = await dinerTap(body, env, "pay:");
  if (tap instanceof Response) return tap;
  if (tap.bill.status !== "confirmed") return notConfirmed(tap, env, ctx, paused(tap));

  const group = await frozenGroup(env, tap);
  if (tap.who === tap.bill.payerId) return payerReply(env, tap, group);
  if (!group) return privately(NO_SHARE);
  const payer = nameOf(tap.participants, tap.bill.payerId);
  const shares = [...(group.own ? [group.own] : []), ...group.guests];
  if (shares.every((s) => s.pardoned)) return privately(`${payer} covered your share of this bill, so you don't owe anything.`);
  if (group.owedCents <= 0) return privately("You don't owe anything on this bill.");

  // What is left, not the frozen amount: a link for the full share after a
  // partial payment would ask the person to pay twice. What a guest paid the
  // payer directly was never the tapper's to pay.
  const paid = await paidSoFar(env, tap);
  const settled = paid.get(tap.who) ?? 0;
  const direct = group.guests.filter((g) => (paid.get(g.participant) ?? 0) > 0);
  const owed = group.owedCents - direct.reduce((n, g) => n + paid.get(g.participant)!, 0);
  const remaining = owed - settled;
  if (remaining <= 0) {
    const none = settled > 0 ? paidUp(payer, settled) : "You don't owe anything on this bill.";
    return privately(none + paidDirectlyNote(tap, direct, payer));
  }
  const amount = formatCents(remaining);
  const forBill = escapeMarkdown(billName(tap.bill));
  const head =
    (settled > 0
      ? `You have **${amount}** left to pay ${payer} for ${forBill}: you've paid ${formatCents(settled)} of ${formatCents(owed)}.`
      : `You owe ${payer} **${amount}** for ${forBill}.`) +
    covers(tap, group, payer, direct) +
    " Tap **I paid** on the bill once you've sent it.";
  const handles = await getPaymentHandles(env.DB, tap.bill.payerId);
  if (handles.length === 0) {
    return privately(
      `${head} ${payer} hasn't set a payment method yet, so pay them however you usually do. ` +
        `${payer} can run \`/paywith\` to add Venmo, Cash App or Zelle here.`,
    );
  }

  // Every method on file, in a fixed order: the payer never said which they
  // prefer, so the diner picks.
  const note = clip(billName(tap.bill), MAX_NOTE);
  const notes: string[] = [];
  const buttons: APIButtonComponent[] = [];
  for (const { method, handle } of handles) {
    const link = payLink(method, handle, remaining, note);
    if ("instructions" in link) {
      notes.push(`**${METHOD_NAMES[method]}:** ${escapeMarkdown(link.instructions)}`);
      continue;
    }
    buttons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Link,
      label: `${METHOD_NAMES[method]} ${describeHandle(method, handle)}`,
      url: link.url,
    });
    if (method === "cashapp") {
      notes.push(`**Cash App** fills in the amount but can't take a note from a link, so add "${escapeMarkdown(note)}" yourself.`);
    }
  }
  const lead = buttons.length > 0 ? [head, "The buttons below open the app with the amount filled in; check it before you send."] : [head];
  const rows: APIActionRowComponent<APIButtonComponent>[] = [{ type: ComponentType.ActionRow, components: buttons }];
  return Response.json(ephemeral([...lead, ...notes].join("\n"), buttons.length > 0 ? rows : undefined));
};

export const mathTap: InteractionHandler = async (body, env, ctx) => {
  const tap = await dinerTap(body, env, "math:");
  if (tap instanceof Response) return tap;
  if (tap.bill.status !== "confirmed") {
    return notConfirmed(
      tap,
      env,
      ctx,
      "This bill was reopened, so its amounts are provisional again. Tap **Open the split** to see where they stand.",
    );
  }
  const [group, items, paid] = await Promise.all([frozenGroup(env, tap), getBillItems(env.DB, tap.bill.id), paidSoFar(env, tap)]);
  if (!group?.own) return privately(NO_SHARE);
  const guests = group.guests.map((share) => ({
    name: tap.participants.find((p) => p.id === share.participant)?.displayName ?? "Your guest",
    share,
    paidDirectlyCents: paid.get(share.participant) ?? 0,
  }));
  return privately(renderMath(group.own, items, tap.bill, { guests, payer: nameOf(tap.participants, tap.bill.payerId) }));
};

// One person's objection is enough: a bill somebody knows is wrong must not
// take payments, and waiting for the group is how a tool gets abandoned.
export const notMineTap: InteractionHandler = async (body, env, ctx) => {
  const tap = await dinerTap(body, env, "notmine:");
  if (tap instanceof Response) return tap;
  const already =
    "This bill is already back to a draft, so paying is paused. Tap **Open the split** and take yourself off " +
    "anything that isn't yours.";
  if (tap.bill.status !== "confirmed") return notConfirmed(tap, env, ctx, already);

  let changes: AmountChange[];
  try {
    changes = await reopenBill(env.DB, tap.bill.id);
  } catch (error) {
    if (!(error instanceof BillNotConfirmedError)) throw error;
    // Reopened, deleted or replaced since the read above.
    const now = await getBill(env.DB, tap.bill.id);
    return now ? notConfirmed({ ...tap, bill: now }, env, ctx, already) : privately(NOT_FOUND);
  }
  refreshMessage(tap.bill, env, ctx);
  const who = nameOf(tap.participants, tap.who);
  const payer = nameOf(tap.participants, tap.bill.payerId);
  const lead =
    `${who} flagged something on this bill that isn't theirs, so it's back to a draft and paying is paused ` +
    `until ${payer} fixes it and confirms again.${changes.length > 0 ? " As it stands now:" : ""}`;
  return outLoud(announcement(lead, changes, tap.participants, tap.bill.payerId));
};

function stringOption(body: APIInteraction, name: string): string | null {
  if (body.type !== InteractionType.ApplicationCommand || body.data.type !== ApplicationCommandType.ChatInput) return null;
  const option = (body.data.options ?? []).find((o) => o.name === name);
  return option?.type === ApplicationCommandOptionType.String ? option.value : null;
}

// A handle belongs to the person, not a bill, so setting it once covers every
// bill they pay for, including ones already on the channel: the pay buttons
// look it up at tap time.
export const paywithCommand: InteractionHandler = async (body, env) => {
  const who = invokerOf(body);
  const method = stringOption(body, "method");
  const raw = stringOption(body, "handle");
  if (!who || method === null || raw === null) return privately(NOT_SUPPORTED);
  if (!PAY_METHODS.includes(method as PayMethod)) return privately("Pick Venmo, Cash App or Zelle.");
  const payMethod = method as PayMethod;

  const handle = normalizeHandle(payMethod, raw);
  if (handle === null) {
    return privately(`That doesn't look like a ${METHOD_NAMES[payMethod]} handle, so I didn't save it. ${HANDLE_RULES[payMethod]}`);
  }
  await setPaymentHandle(env.DB, who.id, payMethod, handle);
  return privately(
    `Saved: ${METHOD_NAMES[payMethod]} ${escapeMarkdown(describeHandle(payMethod, handle))}. Anyone who taps **Pay my share** ` +
      "on a bill you paid for is offered it, including bills already posted. Run `/paywith` again to change it.",
  );
};
