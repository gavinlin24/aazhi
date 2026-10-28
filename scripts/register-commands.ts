// Run by hand after changing src/discord/commands.ts:
//   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npx tsx scripts/register-commands.ts
// PUT replaces the whole command set, so a command removed from the list is
// removed from Discord too.
import { commands } from "../src/discord/commands";

declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
if (!applicationId || !botToken) {
  console.error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN in the environment.");
  process.exit(1);
}

const response = await fetch(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});

if (!response.ok) {
  console.error(`Discord rejected the command list (${response.status}): ${await response.text()}`);
  process.exit(1);
}
console.log(`Registered ${commands.length} commands.`);
