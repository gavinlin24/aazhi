import { ApplicationCommandOptionType, ApplicationCommandType, InteractionType, type APIInteraction } from "discord-api-types/v10";
import { setVenmoHandle } from "../../db/handles";
import { normalizeVenmo, VENMO_RULE } from "../../web/paylink";
import type { InteractionHandler } from "../interactions";
import { invokerOf } from "../members";
import { escapeMarkdown } from "../render";
import { ephemeral } from "../rest";

function privately(content: string): Response {
  return Response.json(ephemeral(content));
}

function stringOption(body: APIInteraction, name: string): string | null {
  if (body.type !== InteractionType.ApplicationCommand || body.data.type !== ApplicationCommandType.ChatInput) return null;
  const option = (body.data.options ?? []).find((o) => o.name === name);
  return option?.type === ApplicationCommandOptionType.String ? option.value : null;
}

// A handle belongs to the person, not a bill, so setting it once covers every
// bill they pay for, including ones already on the channel: the page looks it
// up each time it is drawn.
export const paywithCommand: InteractionHandler = async (body, env) => {
  const who = invokerOf(body);
  const raw = stringOption(body, "handle");
  if (!who || raw === null) return privately("That action is not supported.");
  // A Discord client can still send a method from the command list it cached
  // when /paywith offered more than Venmo.
  const method = stringOption(body, "method");
  if (method !== null && method !== "venmo") return privately("Only Venmo works now, so I didn't save that.");

  const handle = normalizeVenmo(raw);
  if (handle === null) return privately(`That doesn't look like a Venmo username, so I didn't save it. ${VENMO_RULE}`);
  await setVenmoHandle(env.DB, who.id, handle);
  return privately(
    `Saved: Venmo ${escapeMarkdown(`@${handle}`)}. Anyone paying you back on a bill you paid for sees it on the page, ` +
      "including bills already posted. Run `/paywith` again to change it.",
  );
};
