import { MessageFlags, type APIInteractionResponse } from "discord-api-types/v10";
import { claimEditLease, type BillRow } from "../db/bills";
import type { Env } from "../env";
import { loadBillMessage } from "./render";

const API = "https://discord.com/api/v10";
// Discord asks every HTTP client to identify itself in this exact shape.
const USER_AGENT = "DiscordBot (https://github.com/gavinlin24/aazhi, 0.1.0)";

export const EDIT_WINDOW_MS = 3000;

// `what` names the call in errors instead of the path, because a webhook path
// carries the interaction token and logs are no place for it.
async function discord(
  env: Env,
  what: string,
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
  auth: "bot" | "none",
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": USER_AGENT };
  if (auth === "bot") headers.authorization = `Bot ${env.DISCORD_BOT_TOKEN}`;
  const response = await fetch(`${API}${path}`, { method, headers, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Discord ${what} failed: ${response.status} ${await response.text()}`);
  return response;
}

// Webhook calls authenticate with the interaction token in the path, so they
// work for its 15 minutes without the bot token.
export async function followUp(interactionToken: string, body: unknown, env: Env): Promise<void> {
  await discord(env, "follow-up", "POST", `/webhooks/${env.DISCORD_APPLICATION_ID}/${interactionToken}`, body, "none");
}

// A new message, unlike an edit, shows up as unread in the channel. It uses
// the bot token because it is sent long after any interaction token expired.
export async function postChannelMessage(channelId: string, body: unknown, env: Env): Promise<void> {
  await discord(env, "channel message", "POST", `/channels/${channelId}/messages`, body, "bot");
}

export async function editOriginal(
  interactionToken: string,
  body: unknown,
  env: Env,
): Promise<{ id: string; channel_id: string }> {
  const response = await discord(
    env,
    "original response edit",
    "PATCH",
    `/webhooks/${env.DISCORD_APPLICATION_ID}/${interactionToken}/messages/@original`,
    body,
    "none",
  );
  return response.json();
}

export function ephemeral(content: string, components?: unknown[]): APIInteractionResponse {
  return {
    type: 4,
    data: { content, flags: MessageFlags.Ephemeral, ...(components ? { components } : {}) },
  } as APIInteractionResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// At most one edit per bill per window, last state winning. Whoever claims the
// lease renders only after the window closes, so any change whose edit was
// refused during the window (it was written before it asked) is in that
// render. The bill message outlives the interaction token, so this uses the
// bot token and the stored ids.
export async function editBillMessage(bill: BillRow, env: Env): Promise<void> {
  if (!bill.messageId) return;
  if (!(await claimEditLease(env.DB, bill.id, EDIT_WINDOW_MS))) return;
  await sleep(EDIT_WINDOW_MS);

  const latest = await loadBillMessage(env.DB, bill.id);
  if (!latest?.bill.messageId) return;
  await discord(
    env,
    "bill message edit",
    "PATCH",
    `/channels/${latest.bill.channelId}/messages/${latest.bill.messageId}`,
    latest.data,
    "bot",
  );
}
