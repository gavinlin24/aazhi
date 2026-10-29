import {
  InteractionType,
  MessageFlags,
  type APIInteraction,
  type APIInteractionResponse,
} from "discord-api-types/v10";
import type { Env } from "../env";
import { confirmTap, deleteConfirmTap, deleteTap, reopenTap, splitOrphansTap } from "./handlers/lifecycle";
import { mathTap, notMineTap, payTap, paywithCommand } from "./handlers/owe";
import { openSplit, pickRoster } from "./handlers/roster";
import { splitCommand, splitMessageCommand } from "./handlers/split";

// `origin` is where this Worker was reached, so a handler can link back to the
// page without a configured URL that would have to be kept in step with the deploy.
export type InteractionHandler = (
  body: APIInteraction,
  env: Env,
  ctx: ExecutionContext,
  origin: string,
) => Promise<Response>;

// The extension point: a later task registers its handler by adding one entry
// here. Commands are keyed by exact name (the message command by its display
// name). Components are keyed by a custom_id prefix, so a handler owns every
// button of its kind and reads the bill id out of the rest of the custom_id.
export const commandHandlers: Record<string, InteractionHandler> = {
  split: splitCommand,
  "Split this receipt": splitMessageCommand,
  paywith: paywithCommand,
};
export const componentHandlers: Record<string, InteractionHandler> = {
  "open:": openSplit,
  "roster:": pickRoster,
  "confirm:": confirmTap,
  "orphans:": splitOrphansTap,
  "reopen:": reopenTap,
  "delete:": deleteTap,
  "delete-confirm:": deleteConfirmTap,
  "pay:": payTap,
  "math:": mathTap,
  "notmine:": notMineTap,
};

function respond(body: APIInteractionResponse): Response {
  return Response.json(body);
}

// Answering instead of throwing: Discord shows an error banner for a non-2xx,
// and a stale button from an older deploy should get an explanation instead.
function notSupported(): Response {
  return respond({
    type: 4,
    data: { content: "That action is not supported.", flags: MessageFlags.Ephemeral },
  });
}

export const handleInteraction: InteractionHandler = async (body, env, ctx, origin) => {
  switch (body.type) {
    case InteractionType.Ping:
      return respond({ type: 1 });
    case InteractionType.ApplicationCommand: {
      const handler = commandHandlers[body.data.name];
      return handler ? handler(body, env, ctx, origin) : notSupported();
    }
    case InteractionType.MessageComponent: {
      const customId = body.data.custom_id;
      const prefix = Object.keys(componentHandlers).find((p) => customId.startsWith(p));
      return prefix ? componentHandlers[prefix]!(body, env, ctx, origin) : notSupported();
    }
    default:
      return notSupported();
  }
};
