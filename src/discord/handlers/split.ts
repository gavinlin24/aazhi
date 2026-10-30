import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionResponseType,
  InteractionType,
  type APIAttachment,
  type APIInteraction,
} from "discord-api-types/v10";
import { addParticipant, createBill, insertItems, ReceiptAlreadySplitError, setBillMessage, supersedeOlderDrafts } from "../../db/bills";
import type { Env } from "../../env";
import { extractReceipt, type Extraction } from "../../extract/claude";
import { grantRead, type ReadPermit } from "../../extract/read-limit";
import { receiptKey } from "../../extract/receipt-key";
import type { InteractionHandler } from "../interactions";
import { displayName } from "../members";
import { loadBillMessage } from "../render";
import { editBillMessage, editOriginal, ephemeral } from "../rest";

export interface Invoker {
  id: string;
  displayName: string;
}

const PAGE_OPTIONS = ["receipt", "page_2", "page_3"];

const NO_PHOTO =
  "I need a photo of the receipt. Attach it to /split, or post the photos in one message, " +
  "then long-press that message (right-click on desktop) and pick Apps > Split this receipt.";

const NOT_IN_SERVER = "Bills belong to a server channel, so run this in one.";

const READ_FAILED: Record<"not-a-receipt" | "unreadable" | "model-error", string> = {
  "not-a-receipt": "I couldn't read a receipt in that photo. Try again with a photo of the itemised receipt.",
  unreadable:
    "I can see a receipt but couldn't make out the prices. Try a sharper photo, taken flat in good light " +
    "with the whole receipt in frame.",
  "model-error": "I couldn't reach the receipt reader just now. Try again in a minute.",
};

const SAVE_FAILED = "Something went wrong saving this bill. Try again in a minute.";

const ALREADY_SPLIT = "This receipt was already split.";

// Cloudflare cancels background work 30 s after the response, silently, so a
// hung read would leave "thinking..." forever. Reading gets 20 s across both
// attempts; saving and posting the bill fit easily in the 10 s left, and the
// one wait after that (the superseded message's edit window) comes after the
// new bill is already on screen.
const READ_DEADLINE_MS = 20_000;

function isImage(attachment: APIAttachment | undefined): attachment is APIAttachment {
  return attachment?.content_type?.startsWith("image/") ?? false;
}

function context(body: APIInteraction): { guildId: string; channelId: string; invoker: Invoker } | null {
  const channelId = body.channel?.id ?? body.channel_id;
  const member = body.member;
  if (!body.guild_id || !channelId || !member) return null;
  const { user } = member;
  return {
    guildId: body.guild_id,
    channelId,
    invoker: { id: user.id, displayName: displayName(user, member.nick) },
  };
}

async function begin(body: APIInteraction, imageUrls: string[], env: Env, ctx: ExecutionContext): Promise<Response> {
  const where = context(body);
  if (!where) return Response.json(ephemeral(NOT_IN_SERVER));
  return startSplit(imageUrls, where.guildId, where.channelId, where.invoker, body.token, env, ctx);
}

export const splitCommand: InteractionHandler = async (body, env, ctx) => {
  if (body.type !== InteractionType.ApplicationCommand || body.data.type !== ApplicationCommandType.ChatInput) {
    return Response.json(ephemeral(NO_PHOTO));
  }
  const options = body.data.options ?? [];
  const attachments = body.data.resolved?.attachments ?? {};
  const imageUrls = PAGE_OPTIONS.flatMap((name) => {
    const option = options.find((o) => o.name === name);
    if (option?.type !== ApplicationCommandOptionType.Attachment) return [];
    const attachment = attachments[option.value];
    return isImage(attachment) ? [attachment.url] : [];
  });
  return begin(body, imageUrls, env, ctx);
};

export const splitMessageCommand: InteractionHandler = async (body, env, ctx) => {
  if (body.type !== InteractionType.ApplicationCommand || body.data.type !== ApplicationCommandType.Message) {
    return Response.json(ephemeral(NO_PHOTO));
  }
  const message = body.data.resolved.messages[body.data.target_id];
  const imageUrls = (message?.attachments ?? []).filter(isImage).map((a) => a.url);
  return begin(body, imageUrls, env, ctx);
};

// Reading a receipt takes longer than Discord's three-second deadline, so the
// interaction is acknowledged at once and everything else runs after the
// response, finishing through the interaction token's 15-minute window. The
// read limit comes first because a deferred reply is public from then on, and
// a refusal has to stay private.
export async function startSplit(
  imageUrls: string[],
  guildId: string,
  channelId: string,
  invoker: Invoker,
  interactionToken: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (imageUrls.length === 0) return Response.json(ephemeral(NO_PHOTO));
  const grant = await grantRead(env.DB, invoker.id, imageUrls);
  if (!grant.ok) return Response.json(ephemeral(grant.refusal));
  ctx.waitUntil(readAndPost(grant.permit, guildId, channelId, invoker, interactionToken, env));
  return Response.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
}

async function saveDraft(e: Extraction, guildId: string, channelId: string, payer: Invoker, db: D1Database) {
  const bill = await createBill(db, {
    id: crypto.randomUUID(),
    guildId,
    channelId,
    messageId: null,
    payerId: payer.id,
    place: e.place,
    billDate: e.billDate,
    discountCents: e.discountCents,
    taxCents: e.taxCents ?? 0,
    tipCents: 0,
    printedTotalCents: e.printedTotalCents,
    status: "draft",
    receiptKey: await receiptKey(e),
  });
  await insertItems(
    db,
    bill.id,
    e.items.map((item) => ({
      id: crypto.randomUUID(),
      label: item.label,
      addons: item.addons,
      cents: item.cents,
      source: "ocr" as const,
      confidence: item.confidence,
    })),
  );
  await addParticipant(db, { billId: bill.id, id: payer.id, kind: "member", displayName: payer.displayName, addedBy: null });
  return bill.id;
}

async function readAndPost(
  permit: ReadPermit,
  guildId: string,
  channelId: string,
  invoker: Invoker,
  interactionToken: string,
  env: Env,
): Promise<void> {
  // A cleared timer rather than AbortSignal.timeout: nothing outlives a read
  // that finished early, and tests can drive the deadline with fake timers.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("receipt read timed out", "TimeoutError")), READ_DEADLINE_MS);
  const read = await extractReceipt(permit, env.ANTHROPIC_API_KEY, { signal: deadline.signal }).finally(() =>
    clearTimeout(timer),
  );
  // A failed read creates nothing and leaves any open draft here alone: a bad
  // rescan should not kill a good bill.
  if (!read.ok) {
    await editOriginal(interactionToken, { content: READ_FAILED[read.reason], allowed_mentions: { parse: [] } }, env);
    return;
  }

  try {
    const billId = await saveDraft(read.extraction, guildId, channelId, invoker, env.DB);
    const rendered = await loadBillMessage(env.DB, billId);
    if (!rendered) throw new Error(`bill ${billId} vanished before it was posted`);
    const message = await editOriginal(interactionToken, rendered.data, env);
    await setBillMessage(env.DB, billId, message.channel_id, message.id);

    // Only once the new bill is on screen does the old one stop being the
    // channel's draft, so a failure above never leaves the channel with none.
    const replaced = await supersedeOlderDrafts(env.DB, channelId, billId);
    const edits = await Promise.allSettled(replaced.map((old) => editBillMessage(old, env)));
    for (const edit of edits) {
      if (edit.status === "rejected") console.error("could not mark a superseded bill", edit.reason);
    }
  } catch (error) {
    // Refused before anything was saved, so this channel's open draft stays.
    if (error instanceof ReceiptAlreadySplitError) {
      await editOriginal(interactionToken, { content: ALREADY_SPLIT, allowed_mentions: { parse: [] } }, env);
      return;
    }
    console.error("split failed", error);
    await editOriginal(interactionToken, { content: SAVE_FAILED, embeds: [], components: [], allowed_mentions: { parse: [] } }, env);
  }
}
