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
import { STAMPS, stampsHeld } from "../../db/stamps";
import { personSummary, type Summary } from "../../db/stats";
import { formatCents } from "../../format";
import { mintMemberProof, mintViewerToken } from "../../web/token";
import type { InteractionHandler } from "../interactions";
import { displayName, invokerOf } from "../members";
import { clip } from "../notices";
import { escapeMarkdown } from "../render";
import { ephemeral, guildName } from "../rest";

const POST_PREFIX = "profile-post:";
export const MAX_NAME = 40;

export function privately(content: string, components?: unknown[]): Response {
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

function profileLine(person: Summary, stamps: number): string {
  const hosted = person.hosted === 1 ? "once" : `${person.hosted} times`;
  const name = escapeMarkdown(clip(person.name, MAX_NAME));
  return `**${name}**: ${plural(person.outings, "outing")}, ${formatCents(person.spentCents)} spent, hosted ${hosted}, ${stamps} of ${STAMPS.length} stamps.`;
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
// who can name them. The no-bills reply means none anywhere, so it names no
// server.
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
        ? "You have no bills yet."
        : `${escapeMarkdown(clip(target!.name, MAX_NAME))} has no bills yet.`,
    );
  }

  const server = await guildName(guildId, env);
  const token = await mintViewerToken(guildId, who.id, server && clip(server, MAX_NAME), env.TOKEN_SIGNING_KEY, Date.now());
  const proof = person === who.id ? null : await mintMemberProof(token, person, env.TOKEN_SIGNING_KEY);
  const stamps = await stampsHeld(env.DB, guildId, person);
  return privately(profileLine(summary, stamps.size), [
    {
      type: ComponentType.ActionRow,
      components: [
        { type: ComponentType.Button, style: ButtonStyle.Link, label: "Open profile", url: profileUrl(origin, guildId, person, who.id, token, proof) },
        { type: ComponentType.Button, style: ButtonStyle.Link, label: "Leaderboard", url: leaderboardUrl(origin, guildId, token) },
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
  const person = body.data.custom_id.slice(POST_PREFIX.length);
  const summary = await personSummary(env.DB, guildId, person);
  if (!summary) return privately("There are no bills to show for them any more.");
  const stamps = await stampsHeld(env.DB, guildId, person);
  return Response.json({
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { content: profileLine(summary, stamps.size), allowed_mentions: { parse: [] } },
  });
};
