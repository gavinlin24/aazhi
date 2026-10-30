import { ApplicationCommandOptionType, ApplicationCommandType, InteractionType, type APIInteraction } from "discord-api-types/v10";
import { ledger, type LedgerRow } from "../../db/settlements";
import { formatCents } from "../../format";
import type { InteractionHandler } from "../interactions";
import { invokerOf } from "../members";
import { clip } from "../notices";
import { escapeMarkdown } from "../render";
import { ephemeral } from "../rest";

// Discord refuses an ephemeral reply over 2000 characters.
const MAX_CONTENT = 2000;
const MAX_NAME = 40;

function privately(content: string): Response {
  return Response.json(ephemeral(content));
}

function booleanOption(body: APIInteraction, name: string): boolean | null {
  if (body.type !== InteractionType.ApplicationCommand || body.data.type !== ApplicationCommandType.ChatInput) return null;
  const option = (body.data.options ?? []).find((o) => o.name === name);
  return option?.type === ApplicationCommandOptionType.Boolean ? option.value : null;
}

// A guest's row is always one bill, so it names the place instead of a count.
function ledgerLine(row: LedgerRow): string {
  const n = row.billCount;
  const name = escapeMarkdown(clip(row.displayName, MAX_NAME));
  const where =
    row.kind === "guest"
      ? `your guest at ${escapeMarkdown(clip(row.place?.trim() || "dinner", MAX_NAME))}`
      : `${n} ${n === 1 ? "bill" : "bills"}`;
  return `- ${name}: ${formatCents(row.owedCents - row.settledCents)} (${where})`;
}

function moreLine(rows: LedgerRow[]): string {
  const cents = rows.reduce((sum, r) => sum + r.owedCents - r.settledCents, 0);
  return `- and ${rows.length} more: ${formatCents(cents)}`;
}

// People are added while they fit; the rest fold into one line carrying
// their total, so the lines still add up to the total underneath.
export function renderLedger(rows: LedgerRow[], everywhere: boolean): string {
  const where = everywhere ? "across every server" : "in this server";
  if (rows.length === 0) {
    const hint = everywhere ? "" : " Run `/ledger everywhere:True` to check every server.";
    return `Nobody owes you anything ${where}.${hint}`;
  }
  const header = `**Who still owes you ${where}**`;
  const total = rows.reduce((sum, r) => sum + r.owedCents - r.settledCents, 0);
  const footer = `**Total: ${formatCents(total)}**`;
  const budget = MAX_CONTENT - header.length - footer.length - 2;

  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < rows.length; i++) {
    const line = ledgerLine(rows[i]!);
    const rest = rows.slice(i + 1);
    const reserve = rest.length > 0 ? moreLine(rest).length + 1 : 0;
    if (used + line.length + 1 + reserve > budget) {
      kept.push(moreLine(rows.slice(i)));
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return [header, ...kept, footer].join("\n");
}

// Outside a server there is no "this server" to scope to, so it rolls up.
export const ledgerCommand: InteractionHandler = async (body, env) => {
  const who = invokerOf(body);
  if (!who) return privately("That action is not supported.");
  const everywhere = booleanOption(body, "everywhere") === true || !body.guild_id;
  const rows = await ledger(env.DB, who.id, everywhere ? undefined : body.guild_id);
  return privately(renderLedger(rows, everywhere));
};

