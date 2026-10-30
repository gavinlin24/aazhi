import {
  InteractionType,
  MessageFlags,
  type APIInteraction,
  type APIInteractionResponse,
} from "discord-api-types/v10";
import type { Env } from "../env";
import { ledgerCommand } from "./handlers/ledger";
import { postProfile, profileCommand } from "./handlers/profile";
import { retired } from "./handlers/retired";
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
  ledger: ledgerCommand,
  profile: profileCommand,
};
// Everything else a bill needs is done on the page now. The prefixes of the
// buttons and forms that used to do it stay mapped, so a tap on a message
// posted before that still gets an answer.
const RETIRED = [
  "confirm:",
  "orphans:",
  "reopen:",
  "delete:",
  "delete-confirm:",
  "pay:",
  "math:",
  "notmine:",
  "paid:",
  "paidall:",
  "paidpart:",
  "undo:",
  "undopick:",
];
export const componentHandlers: Record<string, InteractionHandler> = {
  "open:": openSplit,
  "roster:": pickRoster,
  "profile-post:": postProfile,
  ...Object.fromEntries(RETIRED.map((prefix) => [prefix, retired(prefix)])),
};
// A modal's submit is its own interaction type, keyed the same way by the
// custom_id the modal was opened with.
export const modalHandlers: Record<string, InteractionHandler> = {
  "paidamount:": retired("paidamount:"),
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
    case InteractionType.ModalSubmit: {
      const customId = body.data.custom_id;
      const prefix = Object.keys(modalHandlers).find((p) => customId.startsWith(p));
      return prefix ? modalHandlers[prefix]!(body, env, ctx, origin) : notSupported();
    }
    default:
      return notSupported();
  }
};
