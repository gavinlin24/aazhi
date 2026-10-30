import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  InteractionType,
  type APIInteraction,
  type APIUser,
} from "discord-api-types/v10";
import { personSummary, type Summary } from "../../db/stats";
import { formatCents } from "../../format";
import { mintViewerToken } from "../../web/token";
import type { InteractionHandler } from "../interactions";
import { displayName, invokerOf } from "../members";
import { clip } from "../notices";
import { escapeMarkdown } from "../render";
import { ephemeral, guildName } from "../rest";

const POST_PREFIX = "profile-post:";
const MAX_NAME = 40;

function privately(content: string, components?: unknown[]): Response {
  return Response.json(ephemeral(content, components));
}

interface Target {
  user: APIUser;
  name: string;
}

function targetOf(body: APIInteraction): Target | null {
  if (body.type !== InteractionType.ApplicationCommand || body.data.type !== ApplicationCommandType.ChatInput) return null;
  const option = (body.data.options ?? []).find((o) => o.name === "user");
  if (option?.type !== ApplicationCommandOptionType.User) return null;
  const user = body.data.resolved?.users?.[option.value];
  if (!user) return null;
  return { user, name: displayName(user, body.data.resolved?.members?.[option.value]?.nick) };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function profileLine(person: Summary): string {
  const hosted = person.hosted === 1 ? "once" : `${person.hosted} times`;
  const name = escapeMarkdown(clip(person.name, MAX_NAME));
  return `**${name}**: ${plural(person.outings, "outing")}, ${formatCents(person.spentCents)} spent, hosted ${hosted}.`;
}

function profileUrl(origin: string, guildId: string, person: string, viewer: string, token: string): string {
  const path = person === viewer ? "" : `/u/${encodeURIComponent(person)}`;
  return `${origin}/g/${encodeURIComponent(guildId)}${path}?t=${token}`;
}

// The reply is private because the link in it belongs to one viewer. It works
// from a Discord user id, so someone who has left is still reachable by anyone
// who can name them. Only this server's bills are ever consulted, so the
// no-bills reply is the same whether or not they have bills elsewhere.
export const profileCommand: InteractionHandler = async (body, env, _ctx, origin) => {
  const who = invokerOf(body);
  const guildId = body.guild_id;
  if (!who || !guildId) return privately("That action is not supported.");

  const target = targetOf(body);
  if (target?.user.bot) return privately("Bots can't be on a bill.");
  const person = target?.user.id ?? who.id;

  const summary = await personSummary(env.DB, guildId, person);
  if (!summary) {
    return privately(
      person === who.id
        ? "You have no bills in this server yet."
        : `${escapeMarkdown(clip(target!.name, MAX_NAME))} has no bills in this server yet.`,
    );
  }

  const server = await guildName(guildId, env);
  const token = await mintViewerToken(guildId, who.id, server && clip(server, MAX_NAME), env.TOKEN_SIGNING_KEY, Date.now());
  return privately(profileLine(summary), [
    {
      type: ComponentType.ActionRow,
      components: [
        { type: ComponentType.Button, style: ButtonStyle.Link, label: "Open profile", url: profileUrl(origin, guildId, person, who.id, token) },
        { type: ComponentType.Button, style: ButtonStyle.Secondary, label: "Post it here", custom_id: `${POST_PREFIX}${person}` },
      ],
    },
  ]);
};

// Worked out again on the tap rather than copied from the private reply, so a
// card posted later says what is true now. It answers in public, so nobody
// named in it gets pinged.
export const postProfile: InteractionHandler = async (body, env) => {
  const guildId = body.guild_id;
  if (body.type !== InteractionType.MessageComponent || !guildId) return privately("That action is not supported.");
  const summary = await personSummary(env.DB, guildId, body.data.custom_id.slice(POST_PREFIX.length));
  if (!summary) return privately("There are no bills to show for them in this server any more.");
  return Response.json({
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { content: profileLine(summary), allowed_mentions: { parse: [] } },
  });
};
