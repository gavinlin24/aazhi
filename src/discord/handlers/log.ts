import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  InteractionResponseType,
  MessageFlags,
  PermissionFlagsBits,
  type APIInteraction,
} from "discord-api-types/v10";
import { clearStaleLogDrafts, ReceiptAlreadySplitError, receiptStanding, type ReceiptStanding } from "../../db/bills";
import type { Env } from "../../env";
import { extractReceipt, type Extraction } from "../../extract/claude";
import { looksFake } from "../../extract/fake-check";
import { grantRead, type ReadPermit } from "../../extract/read-limit";
import { logReceiptKey } from "../../extract/receipt-key";
import { receiptAge, receiptStamp } from "../../extract/receipt-time";
import { formatCents } from "../../format";
import { mintToken } from "../../web/token";
import type { InteractionHandler } from "../interactions";
import { escapeMarkdown } from "../render";
import { editOriginal, ephemeral } from "../rest";
import { ALREADY_SPLIT, attachedImages, context, NOT_IN_SERVER, READ_DEADLINE_MS, READ_FAILED, SAVE_FAILED, saveDraft, type Invoker } from "./split";

const NO_PHOTO = "I need a photo of the receipt. Attach it to /log.";
const CANT_POST = "I can't post in this channel, so I can't log here. Run /log in a channel I can post in.";
const NO_TOTAL = "Not logged. I can't find a total on this receipt.";
const LOOKS_FAKE = "This receipt looks fake, so I didn't log it.";
const NOT_CHECKED = "I couldn't check this receipt, so try again.";
const STANDING: Record<ReceiptStanding, string> = {
  split: ALREADY_SPLIT,
  mine: "You already logged this receipt.",
  logged: "This receipt was already logged.",
};
// A link lives 30 minutes, so an older draft can never be finished.
const DRAFT_LIFE_MS = 30 * 60 * 1000;

const THREADS: (ChannelType | undefined)[] = [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread];

// Log it posts here, so this is checked before the read, which is the one step
// that costs money.
function canPost(body: APIInteraction): boolean {
  const send = THREADS.includes(body.channel?.type) ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  const needed = PermissionFlagsBits.ViewChannel | send;
  return (BigInt(body.app_permissions) & needed) === needed;
}

// The server's clock and the printed time, nothing from the person's phone.
export function ageRefusal(e: Pick<Extraction, "billDate" | "billTime">, nowMs: number): string | null {
  switch (receiptAge(e.billDate, e.billTime, nowMs)) {
    case "fresh":
      return null;
    case "no-date":
      return "Not logged. I can't find a date on this receipt.";
    case "ahead":
      return `Not logged. This receipt reads ${receiptStamp(e.billDate, null)}, which hasn't happened yet. Try a sharper photo.`;
    case "too-old":
      return e.billTime
        ? `Too late to log this one. The receipt reads ${receiptStamp(e.billDate, e.billTime)}. You have 8 hours from the time on the receipt.`
        : `Too late to log this one. The receipt reads ${receiptStamp(e.billDate, null)}. It has no time printed, so it has to be from today.`;
  }
}

function offer(e: Extraction, url: string) {
  const place = e.place?.trim();
  const content = place
    ? `Pick what you had.\n${escapeMarkdown(place)}, ${formatCents(e.printedTotalCents ?? 0)} on the receipt.`
    : "I couldn't read the name of this place.\nType it in on the next page.";
  return {
    content,
    allowed_mentions: { parse: [] },
    components: [
      {
        type: ComponentType.ActionRow,
        components: [{ type: ComponentType.Button, style: ButtonStyle.Link, label: "Pick your items", url }],
      },
    ],
  };
}

async function readAndOffer(permit: ReadPermit, guildId: string, channelId: string, invoker: Invoker, interactionToken: string, origin: string, env: Env) {
  const say = (content: string) => editOriginal(interactionToken, { content, allowed_mentions: { parse: [] } }, env);

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("receipt read timed out", "TimeoutError")), READ_DEADLINE_MS);
  // Side by side so the check adds no wait. A refusal doesn't wait for the read
  // either, and stops it, since nothing it finds would change the answer.
  const reading = extractReceipt(permit, env.ANTHROPIC_API_KEY, { signal: deadline.signal });
  const verdict = await looksFake(permit, env.ANTHROPIC_API_KEY, { signal: deadline.signal });
  if (verdict !== "real") {
    clearTimeout(timer);
    deadline.abort();
    await say(verdict === "fake" ? LOOKS_FAKE : NOT_CHECKED);
    await reading;
    return;
  }
  const read = await reading.finally(() => clearTimeout(timer));
  if (!read.ok) {
    await say(READ_FAILED[read.reason]);
    return;
  }

  const e = read.extraction;
  const now = Date.now();
  const refusal = ageRefusal(e, now) ?? (e.printedTotalCents === null ? NO_TOTAL : null);
  if (refusal) {
    await say(refusal);
    return;
  }

  try {
    const key = await logReceiptKey(e, invoker.id);
    const standing = await receiptStanding(env.DB, key, invoker.id);
    if (standing) {
      await say(STANDING[standing]);
      return;
    }
    const billId = await saveDraft(e, guildId, channelId, invoker, env.DB, { receiptKey: key });
    await clearStaleLogDrafts(env.DB, billId, invoker.id, key, new Date(now - DRAFT_LIFE_MS).toISOString());
    const token = await mintToken(billId, invoker.id, env.TOKEN_SIGNING_KEY, now);
    await editOriginal(interactionToken, offer(e, `${origin}/b/${encodeURIComponent(billId)}?t=${token}`), env);
  } catch (error) {
    if (error instanceof ReceiptAlreadySplitError) {
      await say(ALREADY_SPLIT);
      return;
    }
    console.error("log failed", error);
    await say(SAVE_FAILED);
  }
}

// Ephemeral from the first moment: a log is private until Log it, and a refusal
// is nobody's business but the person's.
export const logCommand: InteractionHandler = async (body, env, ctx, origin) => {
  const where = context(body);
  if (!where) return Response.json(ephemeral(NOT_IN_SERVER));
  const imageUrls = attachedImages(body);
  if (imageUrls.length === 0) return Response.json(ephemeral(NO_PHOTO));
  if (!canPost(body)) return Response.json(ephemeral(CANT_POST));
  const grant = await grantRead(env.DB, where.invoker.id, imageUrls);
  if (!grant.ok) return Response.json(ephemeral(grant.refusal));
  ctx.waitUntil(readAndOffer(grant.permit, where.guildId, where.channelId, where.invoker, body.token, origin, env));
  return Response.json({ type: InteractionResponseType.DeferredChannelMessageWithSource, data: { flags: MessageFlags.Ephemeral } });
};
