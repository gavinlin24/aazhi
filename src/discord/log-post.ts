import { MessageFlags } from "discord-api-types/v10";
import { getShares, setBillMessage, type BillRow } from "../db/bills";
import type { Env } from "../env";
import { formatCents } from "../format";
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

function logPostBody(bill: BillRow, spentCents: number) {
  return { ...QUIET, content: `<@${bill.payerId}> spent ${formatCents(spentCents)} at ${escapeMarkdown(onePlace(bill.place ?? ""))}` };
}

// The log is saved first and stands either way: a Discord hiccup shouldn't cost
// someone a real meal. The page says so when a confirmed log has no message.
export async function postLog(bill: BillRow, env: Env): Promise<void> {
  try {
    const id = await postChannelMessage(bill.channelId, logPostBody(bill, await spentOn(bill, env)), env);
    await setBillMessage(env.DB, bill.id, bill.channelId, id);
  } catch (error) {
    console.error("could not post a log to the channel", error);
  }
}

export async function renameLogPost(bill: BillRow, env: Env): Promise<void> {
  if (!bill.messageId) return;
  await editChannelMessage(bill.channelId, bill.messageId, logPostBody(bill, await spentOn(bill, env)), env);
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
