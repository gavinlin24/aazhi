import type { APIInteraction, APIUser } from "discord-api-types/v10";

// The name people see in this server: their server nickname, else the name
// they chose for Discord, else their handle.
export function displayName(user: Pick<APIUser, "username" | "global_name">, nick?: string | null): string {
  return nick ?? user.global_name ?? user.username;
}

export function invokerOf(body: APIInteraction): { id: string; displayName: string } | null {
  const user = body.member?.user ?? body.user;
  if (!user) return null;
  return { id: user.id, displayName: displayName(user, body.member?.nick) };
}
