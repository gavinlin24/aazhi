import { ButtonStyle, ComponentType, MessageFlags } from "discord-api-types/v10";
import { getShares, logPhotos, reopenVote, setBillMessage, setVotePosted, type BillRow } from "../db/bills";
import type { Env } from "../env";
import { formatCents } from "../format";
import { escapeMarkdown } from "./render";
import { deleteChannelMessage, editChannelMessage, postChannelFiles, postChannelMessage } from "./rest";

// Every edit sends these again, or a rename could start pinging people or
// unfurling a link someone typed as the place.
const QUIET = { allowed_mentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds };

const MAX_PLACE = 80;
const FLAGGED = "This receipt looks fake. Real or fake?";
const OUTCOME = { real: "Voted real. It counts.", fake: "Voted fake. This one doesn't count." };

// One line, because this goes in someone's channel and a text box can hold more.
export function onePlace(place: string): string {
  return place.replace(/\s+/g, " ").trim().slice(0, MAX_PLACE);
}

export async function spentOn(bill: BillRow, env: Env): Promise<number> {
  const shares = await getShares(env.DB, bill.id);
  return shares.find((s) => s.participant === bill.payerId)?.owedCents ?? 0;
}

function spentLine(bill: BillRow, spentCents: number): string {
  return `<@${bill.payerId}> spent ${formatCents(spentCents)} at ${escapeMarkdown(onePlace(bill.place ?? ""))}`;
}

export interface Tally {
  real: number;
  fake: number;
}

// One function for every state of the post, because a rename after a vote has
// to keep the verdict on it.
export function logPostBody(bill: BillRow, spentCents: number, tally: Tally = { real: 0, fake: 0 }) {
  const line = spentLine(bill, spentCents);
  if (bill.vote === "real" || bill.vote === "fake") return { ...QUIET, content: `${line}\n${OUTCOME[bill.vote]}`, components: [] };
  if (bill.vote === null) return { ...QUIET, content: line };
  const count = tally.real + tally.fake > 0 ? ` Real ${tally.real} · Fake ${tally.fake}` : "";
  return {
    ...QUIET,
    content: `${line}\n${FLAGGED}${count}`,
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.Button, style: ButtonStyle.Success, label: "Real", custom_id: `logvote:real:${bill.id}` },
          { type: ComponentType.Button, style: ButtonStyle.Danger, label: "Fake", custom_id: `logvote:fake:${bill.id}` },
        ],
      },
    ],
  };
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

// False when it couldn't be posted. Unlike a plain log this has to land: with no
// post nobody can vote, so the log goes back to a draft to try again.
export async function postVote(bill: BillRow, env: Env): Promise<boolean> {
  try {
    const body = logPostBody(bill, await spentOn(bill, env));
    const id = await postChannelFiles(bill.channelId, body, await logPhotos(env.DB, bill.id), env);
    await setVotePosted(env.DB, bill.id, id);
    return true;
  } catch (error) {
    console.error("could not post a flagged receipt", error);
    await reopenVote(env.DB, bill.id);
    return false;
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
