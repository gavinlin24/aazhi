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
  getShares,
  reopenBill,
  type AmountChange,
  type BillRow,
  type Participant,
} from "../../db/bills";
import { getPaymentHandles, setPaymentHandle } from "../../db/handles";
import type { Env } from "../../env";
import { formatCents, formatDate } from "../../format";
import { itemPieces } from "../../money/split";
import type { LineItem, Share } from "../../money/types";
import { describeHandle, HANDLE_RULES, METHOD_NAMES, normalizeHandle, PAY_METHODS, payLink, type PayMethod } from "../../web/paylink";
import type { InteractionHandler } from "../interactions";
import { invokerOf } from "../members";
import { escapeMarkdown } from "../render";
import { ephemeral } from "../rest";
import {
  announcement,
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
const NO_SHARE = "You have no share on this bill, so there's nothing for you to pay.";
// An ephemeral message tops out at 2000 characters; past this many lines the
// rest are summed into one so the arithmetic still closes.
const MAX_MATH_LINES = 20;
const MAX_LABEL = 60;
const MAX_NOTE = 60;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function billName(bill: BillRow): string {
  const date = formatDate(bill.billDate);
  return `${bill.place?.trim() || "dinner"}${date ? `, ${date}` : ""}`;
}

// The person's items, their tax and tip slices, and the fraction of the bill
// subtotal that produced them. The fraction stays integer cents over integer
// cents; a percentage would be a rounded float standing in for the real ratio.
// Every amount shown is a frozen share figure, so the lines sum to what the
// card says the person owes.
export function renderMath(share: Share, items: LineItem[], bill: BillRow): string {
  const billSubtotal = items.reduce((sum, item) => sum + item.cents, 0);
  const mine = items.flatMap((item) => {
    const piece = itemPieces(item).get(share.participant);
    return piece === undefined ? [] : [{ item, piece }];
  });

  const shown = mine.length > MAX_MATH_LINES ? mine.slice(0, MAX_MATH_LINES - 1) : mine;
  const lines = shown.map(({ item, piece }) => {
    const label = escapeMarkdown(clip(item.label, MAX_LABEL));
    const ways = item.claimedBy.length;
    return ways > 1 ? `${label}: ${formatCents(item.cents)} split ${ways} ways = ${formatCents(piece)}` : `${label}: ${formatCents(piece)}`;
  });
  const rest = mine.slice(shown.length);
  if (rest.length > 0) {
    const restCents = rest.reduce((sum, { piece }) => sum + piece, 0);
    lines.push(`${rest.length} more lines: ${formatCents(restCents)} (all of them are on the page)`);
  }

  const ratio = `${share.subtotalCents}/${billSubtotal}`;
  const sum =
    `**${formatCents(share.subtotalCents)} + ${formatCents(share.taxCents)} + ${formatCents(share.tipCents)} = ` +
    `${formatCents(share.owedCents)}**`;
  const out = [`**Your math for ${escapeMarkdown(billName(bill))}**`, ...lines];
  if (billSubtotal === 0) {
    out.push(`Your items: ${formatCents(share.subtotalCents)}. The lines add up to $0.00, so there was no tax or tip to share.`, sum);
  } else {
    out.push(
      `Your items: **${formatCents(share.subtotalCents)}**, which is ${ratio} of the ${formatCents(billSubtotal)} bill subtotal.`,
      `Tax: ${formatCents(bill.taxCents)} × ${ratio} = ${formatCents(share.taxCents)}`,
      `Tip: ${formatCents(bill.tipCents)} × ${ratio} = ${formatCents(share.tipCents)}`,
      sum,
      "Tax and tip are rounded to the cent so that everyone's shares add up to the bill exactly.",
    );
  }
  if (share.participant === bill.payerId) out.push("You paid the bill, so this is your own part of it.");
  return out.join("\n");
}

interface DinerTap {
  bill: BillRow;
  participants: Participant[];
  who: string;
}

// The owe card's buttons are on one message everyone sees, so every tap is
// about the tapper: it has to be someone on the bill, and the answer is theirs.
async function dinerTap(body: APIInteraction, env: Env, prefix: string): Promise<DinerTap | Response> {
  const ids = parseCustomId(body, prefix, false);
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
function notConfirmed(tap: DinerTap, env: Env, ctx: ExecutionContext, draft: string): Response {
  if (tap.bill.status !== "draft") return privately(STATUS_REFUSAL[tap.bill.status]);
  refreshMessage(tap.bill, env, ctx);
  return privately(draft);
}

function paused(tap: DinerTap): string {
  return `This bill was reopened, so paying is paused until ${nameOf(tap.participants, tap.bill.payerId)} confirms it again.`;
}

async function frozenShare(env: Env, tap: DinerTap): Promise<Share | undefined> {
  return (await getShares(env.DB, tap.bill.id)).find((s) => s.participant === tap.who);
}

function methodList(methods: PayMethod[]): string {
  const names = methods.map((m) => METHOD_NAMES[m]);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const PAYWITH_HINT = "run `/paywith` to add your Venmo, Cash App or Zelle, and every bill you pay for will offer it";

async function payerReply(env: Env, tap: DinerTap, share: Share | undefined): Promise<Response> {
  const handles = await getPaymentHandles(env.DB, tap.who);
  const own = share ? ` Your own part of it was ${formatCents(share.owedCents)}.` : "";
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

  const share = await frozenShare(env, tap);
  if (tap.who === tap.bill.payerId) return payerReply(env, tap, share);
  if (!share) return privately(NO_SHARE);
  const payer = nameOf(tap.participants, tap.bill.payerId);
  if (share.pardoned) return privately(`${payer} covered your share of this bill, so you don't owe anything.`);
  if (share.owedCents <= 0) return privately("You don't owe anything on this bill.");

  const amount = formatCents(share.owedCents);
  const head = `You owe ${payer} **${amount}** for ${escapeMarkdown(billName(tap.bill))}.`;
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
    const link = payLink(method, handle, share.owedCents, note);
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
  const [share, items] = await Promise.all([frozenShare(env, tap), getBillItems(env.DB, tap.bill.id)]);
  if (!share) return privately(NO_SHARE);
  return privately(renderMath(share, items, tap.bill));
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
