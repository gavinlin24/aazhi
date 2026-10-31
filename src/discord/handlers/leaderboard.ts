import { mintViewerToken } from "../../web/token";
import type { InteractionHandler } from "../interactions";
import { invokerOf } from "../members";
import { clip } from "../notices";
import { guildName } from "../rest";
import { leaderboardUrl, MAX_NAME, privateLink, privately } from "./profile";

// Private for the same reason as /profile: the link belongs to one viewer.
export const leaderboardCommand: InteractionHandler = async (body, env, _ctx, origin) => {
  const who = invokerOf(body);
  const guildId = body.guild_id;
  if (!who || !guildId) return privately("That action is not supported.");

  const server = await guildName(guildId, env);
  const token = await mintViewerToken(guildId, who.id, server && clip(server, MAX_NAME), env.TOKEN_SIGNING_KEY, Date.now());
  return privateLink("Open leaderboard", leaderboardUrl(origin, guildId, token));
};
