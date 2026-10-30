import { InteractionResponseType, InteractionType } from "discord-api-types/v10";
import { castVote, getBill } from "../../db/bills";
import type { InteractionHandler } from "../interactions";
import { logPostBody, spentOn } from "../log-post";
import { ephemeral, guildMemberCount } from "../rest";

const VOTE_OVER = "This vote is over.";
const OWN_RECEIPT = "You can't vote on your own receipt.";
const ALREADY_VOTED = "You already voted.";

// The first side to two wins. In a two-person server, the only other person
// is the whole vote. The count includes this bot, so three is two people.
async function votesNeeded(guildId: string, env: Parameters<typeof guildMemberCount>[1]): Promise<number> {
  const members = await guildMemberCount(guildId, env);
  return members !== null && members - 1 <= 2 ? 1 : 2;
}

export const logVote: InteractionHandler = async (body, env) => {
  const voter = body.member?.user.id;
  if (body.type !== InteractionType.MessageComponent || !voter) return Response.json(ephemeral(VOTE_OVER));
  const [, side, billId = ""] = body.data.custom_id.split(":");

  const bill = await getBill(env.DB, billId);
  if (bill?.vote !== "open") return Response.json(ephemeral(VOTE_OVER));
  if (bill.payerId === voter) return Response.json(ephemeral(OWN_RECEIPT));

  const tally = await castVote(env.DB, billId, voter, side === "real", await votesNeeded(bill.guildId, env));
  if (!tally) return Response.json(ephemeral(VOTE_OVER));
  if (!tally.landed) return Response.json(ephemeral(tally.vote === "open" ? ALREADY_VOTED : VOTE_OVER));
  const data = logPostBody(tally.bill, await spentOn(tally.bill, env), tally);
  return Response.json({ type: InteractionResponseType.UpdateMessage, data });
};
