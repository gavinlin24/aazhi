import { MessageFlags } from "discord-api-types/v10";
import { getParticipants, getShares, setBillMessage, type BillRow } from "../db/bills";
import { stampsFromBill, type Earned } from "../db/stamps";
import type { Env } from "../env";
import { formatCents } from "../format";
import { withStamps } from "./notices";
import { escapeMarkdown } from "./render";
import { deleteChannelMessage, editChannelMessage, postChannelMessage } from "./rest";

// Every edit sends these again, or a rename could start pinging people or
// unfurling a link someone typed as the place.
const QUIET = { allowed_mentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds };

const MAX_PLACE = 80;

// One line, because this goes in someone's channel and a text box can hold more.
export function onePlace(place: string): string {
  return place.replace(/\s+/g, " ").trim().slice(0, MAX_PLACE);
}

async function spentOn(bill: BillRow, env: Env): Promise<number> {
  const shares = await getShares(env.DB, bill.id);
  return shares.find((s) => s.participant === bill.payerId)?.owedCents ?? 0;
}

async function logPostBody(bill: BillRow, earned: Earned[], env: Env) {
  const [spentCents, participants] = await Promise.all([spentOn(bill, env), getParticipants(env.DB, bill.id)]);
  const line = `<@${bill.payerId}> spent ${formatCents(spentCents)} at ${escapeMarkdown(onePlace(bill.place ?? ""))}`;
  return { ...QUIET, content: withStamps(line, participants, earned) };
}

// The log is saved first and stands either way: a Discord hiccup shouldn't cost
// someone a real meal. The page says so when a confirmed log has no message.
export async function postLog(bill: BillRow, env: Env, earned: Earned[] = []): Promise<void> {
  try {
    const id = await postChannelMessage(bill.channelId, await logPostBody(bill, earned, env), env);
    await setBillMessage(env.DB, bill.id, bill.channelId, id);
  } catch (error) {
    console.error("could not post a log to the channel", error);
  }
}

export async function renameLogPost(bill: BillRow, env: Env): Promise<void> {
  if (!bill.messageId) return;
  await editChannelMessage(bill.channelId, bill.messageId, await logPostBody(bill, await stampsFromBill(env.DB, bill.id, bill.payerId), env), env);
}

// False if the post is still up. The log is gone by now either way.
export async function removeLogPost(log: Pick<BillRow, "channelId" | "messageId">, env: Env): Promise<boolean> {
  if (!log.messageId) return true;
  try {
    await deleteChannelMessage(log.channelId, log.messageId, env);
    return true;
  } catch (error) {
    console.error("could not remove a log's post", error);
    return false;
  }
}
