import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type APIInteraction,
  type APIUser,
} from "discord-api-types/v10";
import { mintMemberProof, mintViewerToken } from "../../web/token";
import type { InteractionHandler } from "../interactions";
import { invokerOf } from "../members";
import { clip } from "../notices";
import { ephemeral, guildName } from "../rest";

export const MAX_NAME = 40;

export function privately(content: string): Response {
  return Response.json(ephemeral(content));
}

// The button is the whole reply, so there is no text to go with it.
export function privateLink(label: string, url: string): Response {
  return Response.json({
    type: InteractionResponseType.ChannelMessageWithSource,
    data: {
      flags: MessageFlags.Ephemeral,
      components: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Link, label, url }] }],
    },
  });
}

function targetOf(body: APIInteraction): APIUser | null {
  if (body.type !== InteractionType.ApplicationCommand || body.data.type !== ApplicationCommandType.ChatInput) return null;
  const option = (body.data.options ?? []).find((o) => o.name === "user");
  if (option?.type !== ApplicationCommandOptionType.User) return null;
  return body.data.resolved?.users?.[option.value] ?? null;
}

function profileUrl(origin: string, guildId: string, person: string, viewer: string, token: string, proof: string | null): string {
  const path = person === viewer ? "" : `/u/${encodeURIComponent(person)}`;
  return `${origin}/g/${encodeURIComponent(guildId)}${path}?t=${token}${proof ? `&m=${proof}` : ""}`;
}

export function leaderboardUrl(origin: string, guildId: string, token: string): string {
  return `${origin}/g/${encodeURIComponent(guildId)}/boards?t=${token}`;
}

// The reply is private because the link in it belongs to one viewer. It works
// from a Discord user id, so someone who has left is still reachable by anyone
// who can name them. It links even with no bills, and the page says so.
export const profileCommand: InteractionHandler = async (body, env, _ctx, origin) => {
  const who = invokerOf(body);
  const guildId = body.guild_id;
  if (!who || !guildId) return privately("That action is not supported.");

  const target = targetOf(body);
  if (target?.bot) return privately("Bots can't be on a bill.");
  const person = target?.id ?? who.id;

  const server = await guildName(guildId, env);
  const token = await mintViewerToken(guildId, who.id, server && clip(server, MAX_NAME), env.TOKEN_SIGNING_KEY, Date.now());
  const proof = person === who.id ? null : await mintMemberProof(token, person, env.TOKEN_SIGNING_KEY);
  return privateLink("Open profile", profileUrl(origin, guildId, person, who.id, token, proof));
};
