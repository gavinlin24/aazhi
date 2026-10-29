import {
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  InteractionType,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIInteraction,
} from "discord-api-types/v10";
import {
  BillChangedError,
  BillGoneError,
  BillNotConfirmedError,
  BillNotDraftError,
  confirmBill,
  deleteBill,
  getBill,
  getBillSnapshot,
  getParticipants,
  getSettled,
  NobodyClaimedError,
  PaymentsChangedError,
  reopenBill,
  splitOrphansEvenly,
  type AmountChange,
  type BillRow,
  type BillSnapshot,
  type ConfirmRefusal,
  type Participant,
} from "../../db/bills";
import type { Env } from "../../env";
import { formatCents } from "../../format";
import type { InteractionHandler } from "../interactions";
import { invokerOf } from "../members";
import { escapeMarkdown, loadBillMessage } from "../render";
import { editBillMessage, ephemeral } from "../rest";

export const NOT_SUPPORTED = "That action is not supported.";
export const NOT_FOUND = "I can't find that split any more. It may have been removed.";
export const STATUS_REFUSAL: Record<BillRow["status"], string> = {
  reading: "I'm still reading this receipt. Try again in a moment.",
  draft: "This bill isn't confirmed, so there's nothing to reopen. Fix it on the page and tap Confirm.",
  confirmed: "This bill is already confirmed.",
  superseded: "This split was replaced by a newer one in this channel, so it can't be changed.",
  deleted: "This split was deleted, so there's nothing left to change on it.",
};
const MAX_LISTED = 10;
const MAX_LABEL = 60;

type Reply = (content: string) => Response;

function json(body: unknown): Response {
  return Response.json(body);
}

export const privately: Reply = (content) => json(ephemeral(content));

// The second step of a two-tap action answers by rewriting its own ephemeral
// prompt, so the prompt's button is gone and cannot be tapped twice.
const inPlace: Reply = (content) =>
  json({ type: InteractionResponseType.UpdateMessage, data: { content, components: [], allowed_mentions: { parse: [] } } });

export function outLoud(content: string): Response {
  return json({ type: InteractionResponseType.ChannelMessageWithSource, data: { content, allowed_mentions: { parse: [] } } });
}

export function nameOf(participants: Participant[], id: string): string {
  const name = participants.find((p) => p.id === id)?.displayName;
  return name ? escapeMarkdown(name) : "the person who paid";
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

// A failed edit only leaves the channel message a little behind; the reply
// already told the person what happened.
export function refreshMessage(bill: BillRow, env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(editBillMessage(bill, env).catch((error) => console.error("could not update the bill message", error)));
}

// "Marcus paid $44.46 and now owes $41.10, so Gavin owes Marcus $3.36." Names
// rather than pronouns, since the bot knows nobody's.
function changeLine(change: AmountChange, participants: Participant[], payerId: string): string {
  const who = nameOf(participants, change.participant);
  const payer = nameOf(participants, payerId);
  const balance = change.nowCents - change.settledCents;
  const settle =
    balance < 0
      ? `so ${payer} owes ${who} ${formatCents(-balance)}.`
      : balance > 0
        ? `so ${who} owes ${payer} ${formatCents(balance)} more.`
        : "so they're square.";
  return `${who} paid ${formatCents(change.settledCents)} and now owes ${formatCents(change.nowCents)}, ${settle}`;
}

export function announcement(lead: string, changes: AmountChange[], participants: Participant[], payerId: string): string {
  return [lead, ...changes.map((c) => `- ${changeLine(c, participants, payerId)}`)].join("\n");
}

// Ids are generated UUIDs, so the custom_id splits cleanly on its colons.
// `pinned` is the number the button was drawn with (a revision, or the payment
// total a delete prompt named), so a tap on an outdated button is caught.
export function parseCustomId(body: APIInteraction, prefix: string, withPinned: boolean): { billId: string; pinned: number } | null {
  if (body.type !== InteractionType.MessageComponent) return null;
  const rest = body.data.custom_id.slice(prefix.length);
  if (!withPinned) return rest ? { billId: rest, pinned: NaN } : null;
  const at = rest.lastIndexOf(":");
  const pinned = Number(rest.slice(at + 1));
  if (at <= 0 || !Number.isInteger(pinned)) return null;
  return { billId: rest.slice(0, at), pinned };
}

interface PayerTap {
  bill: BillRow;
  participants: Participant[];
  who: string;
}

// Every lifecycle button is visible to everyone on the message, so each one
// checks that the tapper paid before doing anything.
async function payerTap(body: APIInteraction, env: Env, billId: string, action: string, reply: Reply): Promise<PayerTap | Response> {
  const who = invokerOf(body);
  if (!who) return reply(NOT_SUPPORTED);
  const bill = await getBill(env.DB, billId);
  if (!bill) return reply(NOT_FOUND);
  if (bill.status === "superseded" || bill.status === "deleted") return reply(STATUS_REFUSAL[bill.status]);
  const participants = await getParticipants(env.DB, bill.id);
  if (who.id !== bill.payerId) {
    return reply(`Only ${nameOf(participants, bill.payerId)} can ${action}, because they paid.`);
  }
  return { bill, participants, who: who.id };
}

function orphanOffer(snapshot: BillSnapshot, revision: number): Response {
  const { bill, input } = snapshot;
  const orphans = input.items.filter((i) => i.claimedBy.length === 0);
  const claimants = new Set(input.items.flatMap((i) => i.claimedBy));
  if (claimants.size === 0) {
    return privately(
      "Nobody has claimed anything yet, so there's nobody to split the lines between. " +
        "Tap **Open the split** and put people on what they had first.",
    );
  }

  const named = orphans
    .slice(0, MAX_LISTED)
    .map((i) => `${escapeMarkdown(i.label.length > MAX_LABEL ? `${i.label.slice(0, MAX_LABEL - 1)}…` : i.label)} (${formatCents(i.cents)})`);
  if (orphans.length > MAX_LISTED) named.push(`${orphans.length - MAX_LISTED} more`);
  const one = orphans.length === 1;
  const content =
    `${one ? "One line has" : `${orphans.length} lines have`} nobody on ${one ? "it" : "them"}: ${list(named)}. ` +
    `I can split ${one ? "it" : "them"} evenly between the ${claimants.size} ${claimants.size === 1 ? "person" : "people"} ` +
    "who claimed something, then confirm the bill. Or tap **Open the split** and put the right people on them.";
  const row: APIActionRowComponent<APIButtonComponent> = {
    type: ComponentType.ActionRow,
    components: [
      { type: ComponentType.Button, style: ButtonStyle.Primary, label: "Split evenly and confirm", custom_id: `orphans:${bill.id}:${revision}` },
    ],
  };
  return json(ephemeral(content, [row]));
}

const REFUSED: Record<"stale" | "unreconciled" | "unclaimed", string> = {
  stale:
    "The bill changed after this message was drawn, so I didn't confirm it. " +
    "The message is catching up now; check the amounts and tap Confirm again.",
  unreconciled:
    "The items and tax don't add up to the printed total any more, so I can't confirm it. " +
    "Fix it on the page and Confirm comes back once it adds up.",
  unclaimed: "Some lines still have nobody on them. Tap **Open the split** and put people on them, then tap Confirm again.",
};

// Why a confirm was refused, read against the bill as it is now: the refusal
// came from an earlier read, and the person needs today's reason.
function whyNotConfirmed(reason: ConfirmRefusal, snapshot: BillSnapshot): string {
  const { bill, participants } = snapshot;
  switch (reason) {
    case "not-payer":
      return `Only ${nameOf(participants, bill.payerId)} can confirm the bill, because they paid.`;
    // Confirmed and reopened again in between: as far as this tap knows, the
    // bill simply changed.
    case "not-draft":
      return bill.status === "draft" ? REFUSED.stale : STATUS_REFUSAL[bill.status];
    default:
      return REFUSED[reason];
  }
}

// After the freeze: the tapper's own reply carries the news. When someone who
// already paid now owes a different amount, that reply is said in the channel
// instead, and the bill message follows on its own edit.
async function confirmedReply(
  billId: string,
  changes: AmountChange[],
  quiet: () => Promise<Response>,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const snapshot = await getBillSnapshot(env.DB, billId);
  if (!snapshot) return privately(NOT_FOUND);
  refreshMessage(snapshot.bill, env, ctx);
  if (changes.length === 0) return quiet();
  const payer = nameOf(snapshot.participants, snapshot.bill.payerId);
  return outLoud(
    announcement(
      `${payer} confirmed the bill again, and the amounts changed for people who had already paid:`,
      changes,
      snapshot.participants,
      snapshot.bill.payerId,
    ),
  );
}

async function updatedBill(billId: string, env: Env): Promise<Response> {
  const rendered = await loadBillMessage(env.DB, billId);
  if (!rendered) return privately(NOT_FOUND);
  return json({ type: InteractionResponseType.UpdateMessage, data: rendered.data });
}

export const confirmTap: InteractionHandler = async (body, env, ctx) => {
  const ids = parseCustomId(body, "confirm:", true);
  const who = invokerOf(body);
  if (!ids || !who) return privately(NOT_SUPPORTED);
  const { billId, pinned: revision } = ids;

  const result = await confirmBill(env.DB, billId, revision, who.id);
  // The message the button sits on is the bill message, so the reply can
  // lock it on the spot; the coalesced edit follows in case an older edit
  // was still in flight.
  if (result.ok) return confirmedReply(billId, result.changes, () => updatedBill(billId, env), env, ctx);

  const snapshot = await getBillSnapshot(env.DB, billId);
  if (!snapshot) return privately(NOT_FOUND);
  if (result.reason === "unclaimed") return orphanOffer(snapshot, revision);
  // A refusal that means the message is out of date also brings it up to
  // date, so the stale button the person tapped goes away.
  if (result.reason !== "not-payer") refreshMessage(snapshot.bill, env, ctx);
  return privately(whyNotConfirmed(result.reason, snapshot));
};

export const splitOrphansTap: InteractionHandler = async (body, env, ctx) => {
  const ids = parseCustomId(body, "orphans:", true);
  if (!ids) return inPlace(NOT_SUPPORTED);
  const tap = await payerTap(body, env, ids.billId, "confirm the bill", inPlace);
  if (tap instanceof Response) return tap;
  if (tap.bill.status !== "draft") return inPlace(STATUS_REFUSAL[tap.bill.status]);

  let revision: number;
  try {
    revision = await splitOrphansEvenly(env.DB, tap.bill.id, { revision: ids.pinned });
  } catch (error) {
    const changed = "The bill changed since I offered this, so I left it alone. Check it and tap Confirm again.";
    if (error instanceof BillChangedError) return inPlace(changed);
    if (error instanceof NobodyClaimedError) {
      return inPlace("Nobody has claimed anything any more, so there's nobody to split the lines between.");
    }
    if (error instanceof BillNotDraftError) {
      // Confirmed, deleted or replaced while the offer sat there; a bill
      // that is a draft again was confirmed and reopened in between.
      const now = await getBill(env.DB, tap.bill.id);
      if (!now) return inPlace(NOT_FOUND);
      return inPlace(now.status === "draft" ? changed : STATUS_REFUSAL[now.status]);
    }
    throw error;
  }

  const result = await confirmBill(env.DB, tap.bill.id, revision, tap.who);
  if (result.ok) {
    return confirmedReply(
      tap.bill.id,
      result.changes,
      async () => inPlace("Split the unclaimed lines evenly between everyone who claimed something, and confirmed the bill."),
      env,
      ctx,
    );
  }
  // The claims landed even though the freeze did not, so the message has to
  // show them either way.
  refreshMessage(tap.bill, env, ctx);
  const snapshot = await getBillSnapshot(env.DB, tap.bill.id);
  if (!snapshot) return inPlace(NOT_FOUND);
  return inPlace(`I split the unclaimed lines evenly, but didn't confirm. ${whyNotConfirmed(result.reason, snapshot)}`);
};

export const reopenTap: InteractionHandler = async (body, env, ctx) => {
  const ids = parseCustomId(body, "reopen:", false);
  if (!ids) return privately(NOT_SUPPORTED);
  const tap = await payerTap(body, env, ids.billId, "reopen the bill", privately);
  if (tap instanceof Response) return tap;

  let changes: AmountChange[];
  try {
    changes = await reopenBill(env.DB, tap.bill.id);
  } catch (error) {
    if (error instanceof BillNotConfirmedError) return privately(STATUS_REFUSAL.draft);
    throw error;
  }
  refreshMessage(tap.bill, env, ctx);
  if (changes.length === 0) return updatedBill(tap.bill.id, env);
  return outLoud(
    announcement(
      `${nameOf(tap.participants, tap.bill.payerId)} reopened the bill to fix it, so paying is paused until it's confirmed again. ` +
        "As it stands now:",
      changes,
      tap.participants,
      tap.bill.payerId,
    ),
  );
};

// Deleting discards everyone's claims, so it always asks once; when people
// have already paid, the question names every payment it would discard. The
// button carries the total it named, so the delete only goes through for
// exactly the payments the payer was shown.
async function deletePrompt(tap: PayerTap, env: Env, lead = "") {
  const settled = (await getSettled(env.DB, tap.bill.id)).filter((s) => s.cents !== 0);
  const total = settled.reduce((sum, s) => sum + s.cents, 0);
  let content = `${lead}Delete this bill? Everyone's claims on it go with it, and there's no undo.`;
  if (settled.length > 0) {
    const payments = settled.map((s) => `${nameOf(tap.participants, s.participant)} paid ${formatCents(s.cents)}`);
    content =
      `${lead}Delete this bill? Payments are recorded against it: ${list(payments)}. ` +
      `Deleting it discards ${formatCents(total)} of recorded payments along with everyone's claims, and there's no undo.`;
  }
  const row: APIActionRowComponent<APIButtonComponent> = {
    type: ComponentType.ActionRow,
    components: [
      { type: ComponentType.Button, style: ButtonStyle.Danger, label: "Delete the bill", custom_id: `delete-confirm:${tap.bill.id}:${total}` },
    ],
  };
  return { content, components: [row] };
}

export const deleteTap: InteractionHandler = async (body, env) => {
  const ids = parseCustomId(body, "delete:", false);
  if (!ids) return privately(NOT_SUPPORTED);
  const tap = await payerTap(body, env, ids.billId, "delete the bill", privately);
  if (tap instanceof Response) return tap;

  const prompt = await deletePrompt(tap, env);
  return json(ephemeral(prompt.content, prompt.components));
};

export const deleteConfirmTap: InteractionHandler = async (body, env, ctx) => {
  const ids = parseCustomId(body, "delete-confirm:", true);
  if (!ids) return inPlace(NOT_SUPPORTED);
  const tap = await payerTap(body, env, ids.billId, "delete the bill", inPlace);
  if (tap instanceof Response) return tap;

  try {
    await deleteBill(env.DB, tap.bill.id, ids.pinned);
  } catch (error) {
    if (error instanceof BillGoneError) return inPlace("This split is already gone.");
    if (error instanceof PaymentsChangedError) {
      // Asked again in place, so the button that would discard unseen
      // payments is replaced by one naming them.
      const prompt = await deletePrompt(tap, env, "Payments changed since I asked, so I didn't delete anything. ");
      return json({
        type: InteractionResponseType.UpdateMessage,
        data: { ...prompt, allowed_mentions: { parse: [] } },
      });
    }
    throw error;
  }
  refreshMessage(tap.bill, env, ctx);
  return inPlace("Deleted the bill. Its message in the channel now says so.");
};
