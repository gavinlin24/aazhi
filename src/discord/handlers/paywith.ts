import { ApplicationCommandOptionType, ApplicationCommandType, InteractionType, type APIInteraction } from "discord-api-types/v10";
import { setPaymentHandle } from "../../db/handles";
import { describeHandle, HANDLE_RULES, METHOD_NAMES, normalizeHandle, PAY_METHODS, type PayMethod } from "../../web/paylink";
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
  const method = stringOption(body, "method");
  const raw = stringOption(body, "handle");
  if (!who || method === null || raw === null) return privately("That action is not supported.");
  if (!PAY_METHODS.includes(method as PayMethod)) return privately("Pick Venmo or Cash App.");
  const payMethod = method as PayMethod;

  const handle = normalizeHandle(payMethod, raw);
  if (handle === null) {
    return privately(`That doesn't look like a ${METHOD_NAMES[payMethod]} handle, so I didn't save it. ${HANDLE_RULES[payMethod]}`);
  }
  await setPaymentHandle(env.DB, who.id, payMethod, handle);
  return privately(
    `Saved: ${METHOD_NAMES[payMethod]} ${escapeMarkdown(describeHandle(payMethod, handle))}. Anyone paying you back on a bill ` +
      "you paid for sees it on the page, including bills already posted. Run `/paywith` again to change it.",
  );
};
