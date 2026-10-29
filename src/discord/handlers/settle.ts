import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  InteractionType,
  TextInputStyle,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIInteraction,
  type APIModalInteractionResponse,
  type APISelectMenuOption,
  type APIStringSelectComponent,
} from "discord-api-types/v10";
import { BillNotConfirmedError, getBill, type Participant } from "../../db/bills";
import {
  getSettlement,
  ledger,
  listSettlements,
  outstanding,
  recordSettlement,
  SettlementGoneError,
  SettlementRefusedError,
  undoSettlement,
  type LedgerRow,
  type Outstanding,
  type Settlement,
} from "../../db/settlements";
import type { Env } from "../../env";
import { parsePriceCents } from "../../extract/schema";
import { formatCents, formatDate } from "../../format";
import { debtorOf } from "../../money/debtors";
import type { Cents } from "../../money/types";
import type { InteractionHandler } from "../interactions";
import { invokerOf } from "../members";
import { escapeMarkdown } from "../render";
import { ephemeral } from "../rest";
import { nameOf, NOT_FOUND, NOT_SUPPORTED, outLoud, parseCustomId, payerTap, privately, STATUS_REFUSAL } from "./lifecycle";
import { billName, clip, dinerTap, NO_SHARE, notConfirmed, paidUp, paused, type DinerTap } from "./owe";

const MAX_CONTENT = 2000;
const MAX_NAME = 40;
// Discord's caps on one string select: 25 options, 100 characters a label.
const MAX_OPTIONS = 25;
const MAX_OPTION_TEXT = 100;
const PAYER_RECORDS =
  "You paid the bill, so there's nothing for you to record. People tap **I paid** once they've sent their share, " +
  "and **Undo a payment** takes one back.";
const UNREADABLE =
  "I couldn't read that as an amount. Enter what you sent as a plain number like 20 or 20.50, with at most two decimals.";

// The person's own text, read like every other amount: by its digits, never
// through a float. A leading "$" is how people write money, so it is allowed;
// anything else that is not a plain amount is refused.
export function parseAmount(typed: string): Cents | null {
  return parsePriceCents(typed.trim().replace(/^\$/, ""));
}

function left(balance: Outstanding): Cents {
  return balance.owedCents - balance.settledCents;
}

async function balanceOf(env: Env, billId: string, who: string): Promise<Outstanding | undefined> {
  return (await outstanding(env.DB, billId)).find((o) => o.participant === who);
}

// Who the tap is from and what they still owe, or the reason there is
// nothing for them to record.
async function owing(env: Env, ctx: ExecutionContext, tap: DinerTap): Promise<Outstanding | Response> {
  if (tap.bill.status !== "confirmed") return notConfirmed(tap, env, ctx, paused(tap));
  if (tap.who === tap.bill.payerId) return privately(PAYER_RECORDS);
  const balance = await balanceOf(env, tap.bill.id, tap.who);
  if (!balance) return privately(NO_SHARE);
  if (left(balance) <= 0) return privately(nothingLeft(tap, balance));
  return balance;
}

function nothingLeft(tap: DinerTap, balance: Outstanding): string {
  if (balance.settledCents > 0) return paidUp(nameOf(tap.participants, tap.bill.payerId), balance.settledCents);
  return "You don't owe anything on this bill.";
}

export const paidTap: InteractionHandler = async (body, env, ctx) => {
  const tap = await dinerTap(body, env, "paid:");
  if (tap instanceof Response) return tap;
  const balance = await owing(env, ctx, tap);
  if (balance instanceof Response) return balance;

  const remaining = left(balance);
  const amount = formatCents(remaining);
  const payer = nameOf(tap.participants, tap.bill.payerId);
  const row: APIActionRowComponent<APIButtonComponent> = {
    type: ComponentType.ActionRow,
    components: [
      // The amount rides along, so a tap after it changed records nothing.
      { type: ComponentType.Button, style: ButtonStyle.Success, label: `Paid it all (${amount})`, custom_id: `paidall:${tap.bill.id}:${remaining}` },
      { type: ComponentType.Button, style: ButtonStyle.Secondary, label: "Paid part", custom_id: `paidpart:${tap.bill.id}` },
    ],
  };
  return Response.json(
    ephemeral(`You have **${amount}** left to pay ${payer} for ${escapeMarkdown(billName(tap.bill))}. Did you send all of it?`, [row]),
  );
};

// What the person is told when the write refused them, worked out against
// the bill as it stands now.
async function refusal(error: SettlementRefusedError, tap: DinerTap, env: Env, ctx: ExecutionContext): Promise<Response> {
  const payer = nameOf(tap.participants, tap.bill.payerId);
  const remaining = formatCents(error.remainingCents ?? 0);
  switch (error.reason) {
    case "not-confirmed": {
      const now = await getBill(env.DB, tap.bill.id);
      return now ? notConfirmed({ ...tap, bill: now }, env, ctx, paused(tap)) : privately(NOT_FOUND);
    }
    case "payer":
      return privately(PAYER_RECORDS);
    case "no-share":
      return privately(NO_SHARE);
    case "not-allowed":
      return privately("You can only record your own payment.");
    case "not-positive":
      return privately("Enter the amount you sent, more than $0.00.");
    case "clear": {
      const balance = await balanceOf(env, tap.bill.id, tap.who);
      return privately(balance ? nothingLeft(tap, balance) : NO_SHARE);
    }
    case "stale":
      return privately(
        `What you owe changed since that button was drawn: you have **${remaining}** left to pay ${payer}. ` +
          "Tap **I paid** again to record it.",
      );
    case "over":
      return privately(`That's more than you have left to pay, which is **${remaining}**. Enter ${remaining} or less.`);
  }
}

// Said in the channel, so a payment is never a quiet change; the owe card
// itself stays as it was frozen. A resent request that was already recorded
// gets the same reply; Discord takes one response per interaction, so that
// reply is never posted twice.
async function record(
  env: Env,
  ctx: ExecutionContext,
  tap: DinerTap,
  cents: Cents,
  options: { remainingCents?: Cents; id?: string } = {},
): Promise<Response> {
  try {
    await recordSettlement(env.DB, tap.bill.id, tap.who, cents, tap.who, options);
  } catch (error) {
    if (error instanceof SettlementRefusedError) return refusal(error, tap, env, ctx);
    throw error;
  }
  const balance = await balanceOf(env, tap.bill.id, tap.who);
  const remaining = balance ? left(balance) : 0;
  const who = nameOf(tap.participants, tap.who);
  const payer = nameOf(tap.participants, tap.bill.payerId);
  const after = remaining > 0 ? `, and has ${formatCents(remaining)} left to pay.` : ", and is all paid up.";
  return outLoud(`${who} paid ${payer} ${formatCents(cents)} for ${escapeMarkdown(billName(tap.bill))}${after}`);
}

export const paidAllTap: InteractionHandler = async (body, env, ctx) => {
  const ids = parseCustomId(body, "paidall:", true);
  const tap = await dinerTap(body, env, "paidall:", ids);
  if (tap instanceof Response) return tap;
  if (tap.bill.status !== "confirmed") return notConfirmed(tap, env, ctx, paused(tap));
  if (tap.who === tap.bill.payerId) return privately(PAYER_RECORDS);
  return record(env, ctx, tap, ids!.pinned, { remainingCents: ids!.pinned });
};

export const paidPartTap: InteractionHandler = async (body, env, ctx) => {
  const tap = await dinerTap(body, env, "paidpart:");
  if (tap instanceof Response) return tap;
  const balance = await owing(env, ctx, tap);
  if (balance instanceof Response) return balance;

  const modal: APIModalInteractionResponse = {
    type: InteractionResponseType.Modal,
    data: {
      custom_id: `paidamount:${tap.bill.id}`,
      title: "Record a payment",
      components: [
        {
          type: ComponentType.Label,
          label: "How much did you send?",
          description: `You have ${formatCents(left(balance))} left to pay on this bill.`,
          component: {
            type: ComponentType.TextInput,
            custom_id: "amount",
            style: TextInputStyle.Short,
            placeholder: "20.00",
            required: true,
            min_length: 1,
            max_length: 12,
          },
        },
      ],
    },
  };
  return Response.json(modal);
};

// A modal's inputs arrive inside a Label, or inside an action row from a
// client that still sends the older layout.
function typedValue(body: APIInteraction, customId: string): string | null {
  if (body.type !== InteractionType.ModalSubmit) return null;
  for (const top of body.data.components) {
    const inner = top.type === ComponentType.Label ? [top.component] : top.type === ComponentType.ActionRow ? top.components : [];
    for (const c of inner) {
      if (c.type === ComponentType.TextInput && c.custom_id === customId) return c.value;
    }
  }
  return null;
}

export const paidAmountSubmit: InteractionHandler = async (body, env, ctx) => {
  const prefix = "paidamount:";
  const billId = body.type === InteractionType.ModalSubmit ? body.data.custom_id.slice(prefix.length) : "";
  const tap = await dinerTap(body, env, prefix, billId ? { billId, pinned: NaN } : null);
  if (tap instanceof Response) return tap;
  if (tap.bill.status !== "confirmed") return notConfirmed(tap, env, ctx, paused(tap));
  if (tap.who === tap.bill.payerId) return privately(PAYER_RECORDS);

  const typed = typedValue(body, "amount");
  const cents = typed === null ? null : parseAmount(typed);
  if (cents === null) return privately(UNREADABLE);
  // Unlike paid-it-all, a typed amount carries nothing that goes stale once
  // it is recorded, so a resent submit would pass every rule again. The
  // interaction id is the payment's id, and a resend answers like the first.
  return record(env, ctx, tap, cents, { id: body.id });
};

// "Oct 29, 2026 09:00 UTC". A select option is plain text, so Discord's
// local-time timestamp markup would show up raw; UTC at least is unambiguous.
function when(iso: string): string {
  const day = formatDate(iso.slice(0, 10)) ?? iso.slice(0, 10);
  return `${day} ${iso.slice(11, 16)} UTC`;
}

// Option labels are plain text, not markdown, so names go in unescaped.
function plainName(participants: Participant[], id: string): string {
  return clip(participants.find((p) => p.id === id)?.displayName ?? "Someone", MAX_NAME);
}

function undoOption(s: Settlement, participants: Participant[]): APISelectMenuOption {
  const by = s.recordedBy === s.participant ? "" : ` by ${plainName(participants, s.recordedBy)}`;
  return {
    label: clip(`${plainName(participants, s.participant)} paid ${formatCents(s.cents)}`, MAX_OPTION_TEXT),
    description: clip(`Recorded ${when(s.recordedAt)}${by}`, MAX_OPTION_TEXT),
    value: s.id,
  };
}

const HELD = "This bill was reopened, so its payments stay as they are until it's confirmed again.";

export const undoTap: InteractionHandler = async (body, env) => {
  const ids = parseCustomId(body, "undo:", false);
  if (!ids) return privately(NOT_SUPPORTED);
  const tap = await payerTap(body, env, ids.billId, "undo a payment", privately);
  if (tap instanceof Response) return tap;
  if (tap.bill.status !== "confirmed") return privately(tap.bill.status === "draft" ? HELD : STATUS_REFUSAL[tap.bill.status]);

  const payments = await listSettlements(env.DB, tap.bill.id);
  if (payments.length === 0) return privately("Nobody has recorded a payment on this bill yet, so there's nothing to undo.");
  const shown = payments.slice(0, MAX_OPTIONS);
  const select: APIStringSelectComponent = {
    type: ComponentType.StringSelect,
    custom_id: `undopick:${tap.bill.id}`,
    placeholder: "Pick the payment to undo",
    min_values: 1,
    max_values: 1,
    options: shown.map((s) => undoOption(s, tap.participants)),
  };
  const more = payments.length > shown.length ? ` These are the ${shown.length} most recent of ${payments.length}.` : "";
  return Response.json(
    ephemeral(`Pick the payment to take back. The person owes that amount again, and the channel is told.${more}`, [
      { type: ComponentType.ActionRow, components: [select] },
    ]),
  );
};

export const undoPick: InteractionHandler = async (body, env) => {
  const ids = parseCustomId(body, "undopick:", false);
  if (!ids || body.type !== InteractionType.MessageComponent || body.data.component_type !== ComponentType.StringSelect) {
    return privately(NOT_SUPPORTED);
  }
  const tap = await payerTap(body, env, ids.billId, "undo a payment", privately);
  if (tap instanceof Response) return tap;
  if (tap.bill.status !== "confirmed") return privately(tap.bill.status === "draft" ? HELD : STATUS_REFUSAL[tap.bill.status]);

  const gone = "That payment isn't on this bill any more, so there's nothing to undo.";
  const picked = body.data.values[0];
  const settlement = picked ? await getSettlement(env.DB, picked) : null;
  if (!settlement || settlement.billId !== tap.bill.id) return privately(gone);
  try {
    await undoSettlement(env.DB, settlement.id);
  } catch (error) {
    if (error instanceof SettlementGoneError) return privately(gone);
    if (error instanceof BillNotConfirmedError) return privately(HELD);
    throw error;
  }

  // A guest's payment was toward what the member who added them owes, so the
  // balance told is that member's.
  const paidBy = tap.participants.find((p) => p.id === settlement.participant);
  const debtor = paidBy ? debtorOf(paidBy, tap.bill.payerId) : settlement.participant;
  const balance = await balanceOf(env, tap.bill.id, debtor);
  const remaining = balance ? left(balance) : 0;
  const who = nameOf(tap.participants, settlement.participant);
  const answers = nameOf(tap.participants, debtor);
  const payer = nameOf(tap.participants, tap.bill.payerId);
  const after = remaining > 0 ? `${answers} has ${formatCents(remaining)} left to pay.` : `${answers} is still all paid up.`;
  return outLoud(
    `${payer} removed ${who}'s ${formatCents(settlement.cents)} payment on ${escapeMarkdown(billName(tap.bill))}. ${after}`,
  );
};

function booleanOption(body: APIInteraction, name: string): boolean | null {
  if (body.type !== InteractionType.ApplicationCommand || body.data.type !== ApplicationCommandType.ChatInput) return null;
  const option = (body.data.options ?? []).find((o) => o.name === name);
  return option?.type === ApplicationCommandOptionType.Boolean ? option.value : null;
}

// A guest's row is always one bill, so it names the place instead of a count.
function ledgerLine(row: LedgerRow): string {
  const n = row.billCount;
  const name = escapeMarkdown(clip(row.displayName, MAX_NAME));
  const where =
    row.kind === "guest"
      ? `your guest at ${escapeMarkdown(clip(row.place?.trim() || "dinner", MAX_NAME))}`
      : `${n} ${n === 1 ? "bill" : "bills"}`;
  return `- ${name}: ${formatCents(row.owedCents - row.settledCents)} (${where})`;
}

function moreLine(rows: LedgerRow[]): string {
  const cents = rows.reduce((sum, r) => sum + r.owedCents - r.settledCents, 0);
  return `- and ${rows.length} more: ${formatCents(cents)}`;
}

// People are added while they fit; the rest fold into one line carrying
// their total, so the lines still add up to the total underneath.
export function renderLedger(rows: LedgerRow[], everywhere: boolean): string {
  const where = everywhere ? "across every server" : "in this server";
  if (rows.length === 0) {
    const hint = everywhere ? "" : " Run `/ledger everywhere:True` to check every server.";
    return `Nobody owes you anything ${where}.${hint}`;
  }
  const header = `**Who still owes you ${where}**`;
  const total = rows.reduce((sum, r) => sum + r.owedCents - r.settledCents, 0);
  const footer = `**Total: ${formatCents(total)}**`;
  const budget = MAX_CONTENT - header.length - footer.length - 2;

  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < rows.length; i++) {
    const line = ledgerLine(rows[i]!);
    const rest = rows.slice(i + 1);
    const reserve = rest.length > 0 ? moreLine(rest).length + 1 : 0;
    if (used + line.length + 1 + reserve > budget) {
      kept.push(moreLine(rows.slice(i)));
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return [header, ...kept, footer].join("\n");
}

// Outside a server there is no "this server" to scope to, so it rolls up.
export const ledgerCommand: InteractionHandler = async (body, env) => {
  const who = invokerOf(body);
  if (!who) return privately(NOT_SUPPORTED);
  const everywhere = booleanOption(body, "everywhere") === true || !body.guild_id;
  const rows = await ledger(env.DB, who.id, everywhere ? undefined : body.guild_id);
  return privately(renderLedger(rows, everywhere));
};

