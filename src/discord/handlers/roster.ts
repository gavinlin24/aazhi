import {
  ButtonStyle,
  ComponentType,
  InteractionType,
  type APIActionRowComponent,
  type APIButtonComponent,
} from "discord-api-types/v10";
import { addParticipant, addParticipants, getBill, getParticipants, type BillRow, type Participant } from "../../db/bills";
import type { Env } from "../../env";
import { mintToken } from "../../web/token";
import type { InteractionHandler } from "../interactions";
import { displayName, invokerOf } from "../members";
import { escapeMarkdown } from "../render";
import { editBillMessage, ephemeral } from "../rest";

const NOT_SUPPORTED = "That action is not supported.";
const NOT_FOUND = "I can't find that split any more. It may have been removed.";
const GONE: Partial<Record<BillRow["status"], string>> = {
  superseded: "This split was replaced by a newer one in this channel. Claim your items on the newer message.",
  deleted: "This split was deleted, so there's nothing to claim on it.",
};

function json(body: unknown): Response {
  return Response.json(body);
}

function billIdFrom(customId: string, prefix: string): string {
  return customId.slice(prefix.length);
}

// The message edit waits out a coalescing window, so it runs after the reply.
// A failed edit only leaves the channel message a little stale; the page is
// the live surface, so it is logged rather than surfaced to the person.
function refreshMessage(bill: BillRow, env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(editBillMessage(bill, env).catch((error) => console.error("could not update the bill message", error)));
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function linkRow(url: string): APIActionRowComponent<APIButtonComponent>[] {
  return [
    {
      type: ComponentType.ActionRow,
      components: [{ type: ComponentType.Button, style: ButtonStyle.Link, label: "Open the split", url }],
    },
  ];
}

// Opening the split is how the roster fills: whoever taps is on the bill. Only
// a draft takes new people; joining a confirmed bill would put a bystander in
// its history and the group's statistics. The link itself works either way.
export const openSplit: InteractionHandler = async (body, env, ctx, origin) => {
  const who = invokerOf(body);
  if (body.type !== InteractionType.MessageComponent || !who) return json(ephemeral(NOT_SUPPORTED));

  const bill = await getBill(env.DB, billIdFrom(body.data.custom_id, "open:"));
  if (!bill) return json(ephemeral(NOT_FOUND));
  const gone = GONE[bill.status];
  if (gone) return json(ephemeral(gone));

  if (bill.status === "draft") {
    const roster = await getParticipants(env.DB, bill.id);
    if (!roster.some((p) => p.id === who.id)) {
      await addParticipant(env.DB, { billId: bill.id, id: who.id, kind: "member", displayName: who.displayName, addedBy: null });
      refreshMessage(bill, env, ctx);
    }
  }

  const token = await mintToken(bill.id, who.id, env.TOKEN_SIGNING_KEY, Date.now());
  const url = `${origin}/b/${encodeURIComponent(bill.id)}?t=${token}`;
  return json(
    ephemeral(
      "Here's your link to the split. It's only for you and works for 30 minutes; " +
        "tap **Open the split** again any time for a fresh one.",
      linkRow(url),
    ),
  );
};

export const pickRoster: InteractionHandler = async (body, env, ctx) => {
  const who = invokerOf(body);
  if (
    body.type !== InteractionType.MessageComponent ||
    body.data.component_type !== ComponentType.UserSelect ||
    !who
  ) {
    return json(ephemeral(NOT_SUPPORTED));
  }

  const bill = await getBill(env.DB, billIdFrom(body.data.custom_id, "roster:"));
  if (!bill) return json(ephemeral(NOT_FOUND));
  const gone = GONE[bill.status];
  if (gone) return json(ephemeral(gone));
  if (bill.status !== "draft") return json(ephemeral("This bill is already confirmed, so nobody new can be added to it."));

  const roster = await getParticipants(env.DB, bill.id);
  if (who.id !== bill.payerId) {
    const payer = roster.find((p) => p.id === bill.payerId)?.displayName;
    return json(
      ephemeral(
        `Only ${payer ? escapeMarkdown(payer) : "the person who paid"} can add people here. ` +
          "If you were at dinner, tap **Open the split** and you're on the bill.",
      ),
    );
  }

  const { users, members } = body.data.resolved;
  const onBill = new Set(roster.map((p) => p.id));
  const picked = body.data.values.map((id) => users[id]).filter((u) => u !== undefined);
  const people = picked.filter((u) => !u.bot);
  const added: Participant[] = people
    .filter((u) => !onBill.has(u.id))
    .map((u) => ({ billId: bill.id, id: u.id, kind: "member", displayName: displayName(u, members?.[u.id]?.nick), addedBy: null }));

  if (added.length === 0) {
    const why = people.length === 0 ? "Bots can't be on a bill." : "Everyone you picked is already on the bill.";
    return json(ephemeral(why));
  }

  await addParticipants(env.DB, bill.id, added);
  refreshMessage(bill, env, ctx);
  const names = listNames(added.map((p) => escapeMarkdown(p.displayName)));
  return json(ephemeral(`Added ${names}. They have chips on the page now, so you can tap them onto their items.`));
};
