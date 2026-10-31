import { ButtonStyle, ComponentType, InteractionResponseType, InteractionType } from "discord-api-types/v10";
import { serverBoards, type Boards, type Ranked } from "../../db/stats";
import { monthName } from "../../format";
import { mintViewerToken } from "../../web/token";
import type { Env } from "../../env";
import type { InteractionHandler } from "../interactions";
import { invokerOf } from "../members";
import { clip } from "../notices";
import { escapeMarkdown } from "../render";
import { guildName } from "../rest";
import { leaderboardUrl, MAX_NAME, privately } from "./profile";

const POST_ID = "leaderboard-post";
// Discord's font draws the page's 一 like a dash, so ranks are written out here.
const RANKS = ["1st", "2nd", "3rd"];
// A tie keeps everyone in it, so friends tied for first all show. The cap only
// guards Discord's message limit against a very wide tie.
const MOST_LINES = 10;

function topOf(rows: Ranked[]): Ranked[] {
  return rows.filter((row) => row.rank <= RANKS.length).slice(0, MOST_LINES);
}

function boardLines(boards: Boards, server: string | null): string {
  const heading = `**${escapeMarkdown(clip(server ?? "This server", MAX_NAME))}, ${monthName(boards.month)}: most hosted**`;
  const rows = topOf(boards.lists["hosted:month"]);
  if (rows.length === 0) return `${heading}\nNobody is on this board yet.`;
  const lines = rows.map((row) => `${RANKS[row.rank - 1]} ${escapeMarkdown(clip(row.name, MAX_NAME))}, ${row.value}`);
  return [heading, ...lines].join("\n");
}

async function hostedNow(env: Env, guildId: string): Promise<{ boards: Boards; server: string | null }> {
  const [boards, server] = await Promise.all([serverBoards(env.DB, guildId, Date.now()), guildName(guildId, env)]);
  return { boards, server };
}

// Private for the same reason as /profile: the link belongs to one viewer. An
// empty board still links out, because All time or another board can have rows.
export const leaderboardCommand: InteractionHandler = async (body, env, _ctx, origin) => {
  const who = invokerOf(body);
  const guildId = body.guild_id;
  if (!who || !guildId) return privately("That action is not supported.");

  const { boards, server } = await hostedNow(env, guildId);
  const token = await mintViewerToken(guildId, who.id, server && clip(server, MAX_NAME), env.TOKEN_SIGNING_KEY, Date.now());
  const open = { type: ComponentType.Button, style: ButtonStyle.Link, label: "Open leaderboard", url: leaderboardUrl(origin, guildId, token) };
  const post = { type: ComponentType.Button, style: ButtonStyle.Secondary, label: "Post it here", custom_id: POST_ID };
  const empty = topOf(boards.lists["hosted:month"]).length === 0;
  return privately(boardLines(boards, server), [{ type: ComponentType.ActionRow, components: empty ? [open] : [open, post] }]);
};

// Like Post it here on /profile, this works the lines out again at the tap and
// pings nobody it names.
export const postLeaderboard: InteractionHandler = async (body, env) => {
  const guildId = body.guild_id;
  if (body.type !== InteractionType.MessageComponent || !guildId) return privately("That action is not supported.");
  const { boards, server } = await hostedNow(env, guildId);
  if (topOf(boards.lists["hosted:month"]).length === 0) return privately("Nobody is on this board yet.");
  return Response.json({
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { content: boardLines(boards, server), allowed_mentions: { parse: [] } },
  });
};
