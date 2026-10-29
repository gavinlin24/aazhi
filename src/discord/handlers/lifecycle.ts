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
  reopenBill,
  splitOrphansEvenly,
  type AmountChange,
  type BillRow,
  type BillSnapshot,
  type Participant,
} from "../../db/bills";
import type { Env } from "../../env";
import { formatCents } from "../../format";
import type { InteractionHandler } from "../interactions";
import { invokerOf } from "../members";
import { escapeMarkdown, loadBillMessage } from "../render";
import { editBillMessage, ephemeral } from "../rest";

const NOT_SUPPORTED = "That action is not supported.";
const NOT_FOUND = "I can't find that split any more. It may have been removed.";
const STATUS_REFUSAL: Record<BillRow["status"], string> = {
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

const privately: Reply = (content) => json(ephemeral(content));

// The second step of a two-tap action answers by rewriting its own ephemeral
// prompt, so the prompt's button is gone and cannot be tapped twice.
const inPlace: Reply = (content) =>
  json({ type: InteractionResponseType.UpdateMessage, data: { content, components: [], allowed_mentions: { parse: [] } } });

function outLoud(content: string): Response {
  return json({ type: InteractionResponseType.ChannelMessageWithSource, data: { content, allowed_mentions: { parse: [] } } });
}

function nameOf(participants: Participant[], id: string): string {
  const name = participants.find((p) => p.id === id)?.displayName;
  return name ? escapeMarkdown(name) : "the person who paid";
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

// A failed edit only leaves the channel message a little behind; the reply
// already told the person what happened.
function refreshMessage(bill: BillRow, env: Env, ctx: ExecutionContext): void {
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

function announcement(lead: string, changes: AmountChange[], participants: Participant[], payerId: string): string {
  return [lead, ...changes.map((c) => `- ${changeLine(c, participants, payerId)}`)].join("\n");
}

// Ids are generated UUIDs, so the custom_id splits cleanly on its colons.
function parseCustomId(body: APIInteraction, prefix: string, withRevision: boolean): { billId: string; revision: number } | null {
  if (body.type !== InteractionType.MessageComponent) return null;
  const rest = body.data.custom_id.slice(prefix.length);
  if (!withRevision) return rest ? { billId: rest, revision: NaN } : null;
  const at = rest.lastIndexOf(":");
  const revision = Number(rest.slice(at + 1));
  if (at <= 0 || !Number.isInteger(revision)) return null;
  return { billId: rest.slice(0, at), revision };
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

const REFUSED: Record<"stale" | "unreconciled", string> = {
  stale:
    "The bill changed after this message was drawn, so I didn't confirm it. " +
    "The message is catching up now; check the amounts and tap Confirm again.",
  unreconciled:
    "The items and tax don't add up to the printed total any more, so I can't confirm it. " +
    "Fix it on the page and Confirm comes back once it adds up.",
};

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

  const result = await confirmBill(env.DB, ids.billId, ids.revision, who.id);
  // The message the button sits on is the bill message, so the reply can
  // lock it on the spot; the coalesced edit follows in case an older edit
  // was still in flight.
  if (result.ok) return confirmedReply(ids.billId, result.changes, () => updatedBill(ids.billId, env), env, ctx);

  const snapshot = await getBillSnapshot(env.DB, ids.billId);
  if (!snapshot) return privately(NOT_FOUND);
  const { bill, participants } = snapshot;
  switch (result.reason) {
    case "not-draft":
      return privately(STATUS_REFUSAL[bill.status]);
    case "not-payer":
      return privately(`Only ${nameOf(participants, bill.payerId)} can confirm the bill, because they paid.`);
    case "unclaimed":
      return orphanOffer(snapshot, ids.revision);
    case "stale":
    case "unreconciled":
      refreshMessage(bill, env, ctx);
      return privately(REFUSED[result.reason]);
  }
};

export const splitOrphansTap: InteractionHandler = async (body, env, ctx) => {
  const ids = parseCustomId(body, "orphans:", true);
  if (!ids) return inPlace(NOT_SUPPORTED);
  const tap = await payerTap(body, env, ids.billId, "confirm the bill", inPlace);
  if (tap instanceof Response) return tap;
  if (tap.bill.status !== "draft") return inPlace(STATUS_REFUSAL[tap.bill.status]);

  let revision: number;
  try {
    revision = await splitOrphansEvenly(env.DB, tap.bill.id, { revision: ids.revision });
  } catch (error) {
    if (error instanceof BillChangedError) {
      return inPlace("The bill changed since I offered this, so I left it alone. Check it and tap Confirm again.");
    }
    if (error instanceof NobodyClaimedError) {
      return inPlace("Nobody has claimed anything any more, so there's nobody to split the lines between.");
    }
    if (error instanceof BillNotDraftError) return inPlace(STATUS_REFUSAL.confirmed);
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
  const why = result.reason === "stale" || result.reason === "unreconciled" ? REFUSED[result.reason] : STATUS_REFUSAL.confirmed;
  return inPlace(`I split the unclaimed lines evenly, but didn't confirm. ${why}`);
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
// have already paid, the question names every payment it would discard.
export const deleteTap: InteractionHandler = async (body, env) => {
  const ids = parseCustomId(body, "delete:", false);
  if (!ids) return privately(NOT_SUPPORTED);
  const tap = await payerTap(body, env, ids.billId, "delete the bill", privately);
  if (tap instanceof Response) return tap;

  const settled = (await getSettled(env.DB, tap.bill.id)).filter((s) => s.cents !== 0);
  let content = "Delete this bill? Everyone's claims on it go with it, and there's no undo.";
  if (settled.length > 0) {
    const total = settled.reduce((sum, s) => sum + s.cents, 0);
    const payments = settled.map((s) => `${nameOf(tap.participants, s.participant)} paid ${formatCents(s.cents)}`);
    content =
      `Delete this bill? Payments are recorded against it: ${list(payments)}. ` +
      `Deleting it discards ${formatCents(total)} of recorded payments along with everyone's claims, and there's no undo.`;
  }
  const row: APIActionRowComponent<APIButtonComponent> = {
    type: ComponentType.ActionRow,
    components: [
      { type: ComponentType.Button, style: ButtonStyle.Danger, label: "Delete the bill", custom_id: `delete-confirm:${tap.bill.id}` },
    ],
  };
  return json(ephemeral(content, [row]));
};

export const deleteConfirmTap: InteractionHandler = async (body, env, ctx) => {
  const ids = parseCustomId(body, "delete-confirm:", false);
  if (!ids) return inPlace(NOT_SUPPORTED);
  const tap = await payerTap(body, env, ids.billId, "delete the bill", inPlace);
  if (tap instanceof Response) return tap;

  try {
    await deleteBill(env.DB, tap.bill.id);
  } catch (error) {
    if (error instanceof BillGoneError) return inPlace("This split is already gone.");
    throw error;
  }
  refreshMessage(tap.bill, env, ctx);
  return inPlace("Deleted the bill. Its message in the channel now says so.");
};
