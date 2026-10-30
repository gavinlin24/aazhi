import { ApplicationCommandOptionType, ApplicationCommandType, InteractionType, type APIInteraction } from "discord-api-types/v10";
import { debts, type BillDebt } from "../../db/settlements";
import { formatCents, formatDate } from "../../format";
import type { Cents, ParticipantId } from "../../money/types";
import { mintToken } from "../../web/token";
import type { InteractionHandler } from "../interactions";
import { invokerOf } from "../members";
import { clip } from "../notices";
import { escapeMarkdown } from "../render";
import { ephemeral } from "../rest";

// Discord refuses an ephemeral reply over 2000 characters.
const MAX_CONTENT = 2000;
const MAX_NAME = 40;
// Room for a section's two fold lines, which no real figure outgrows.
const FOLD_ROOM = 80;
const SECTION_GAP = "\n\n";

interface PersonDebts {
  id: ParticipantId;
  name: string;
  isGuest: boolean;
  bills: BillDebt[];
}

function privately(content: string): Response {
  return Response.json(ephemeral(content));
}

function booleanOption(body: APIInteraction, name: string): boolean | null {
  if (body.type !== InteractionType.ApplicationCommand || body.data.type !== ApplicationCommandType.ChatInput) return null;
  const option = (body.data.options ?? []).find((o) => o.name === name);
  return option?.type === ApplicationCommandOptionType.Boolean ? option.value : null;
}

function left(bill: BillDebt): Cents {
  return bill.owedCents - bill.settledCents;
}

function sum(bills: BillDebt[]): Cents {
  return bills.reduce((n, b) => n + left(b), 0);
}

// Rows arrive newest first, so a person's first row carries the name they go
// by now. Who owes the most leads.
function byPerson(rows: BillDebt[], person: (row: BillDebt) => Omit<PersonDebts, "bills">): PersonDebts[] {
  const people = new Map<ParticipantId, PersonDebts>();
  for (const row of rows) {
    const who = person(row);
    const seen = people.get(who.id);
    if (seen) seen.bills.push(row);
    else people.set(who.id, { ...who, bills: [row] });
  }
  return [...people.values()].sort((a, b) => sum(b.bills) - sum(a.bills) || a.id.localeCompare(b.id));
}

function billLabel(bill: BillDebt): string {
  const place = escapeMarkdown(clip(bill.place?.trim() || "the bill", MAX_NAME));
  const date = formatDate(bill.date);
  return date ? `${place}, ${date}` : place;
}

function billLine(bill: BillDebt, label: string): string {
  return `- ${label}: ${formatCents(left(bill))}`;
}

function personLine(person: PersonDebts): string {
  const name = escapeMarkdown(clip(person.name, MAX_NAME));
  return `${name}${person.isGuest ? " (your guest)" : ""}: ${formatCents(sum(person.bills))}`;
}

// Whatever doesn't fit folds into a line carrying its total: a person's other
// bills under them, and the people after that under the last. So the bill
// lines still add up to each person, and the people to the section's total.
function section(title: string, people: PersonDebts[], budget: number, labelOf: (bill: BillDebt) => string): string[] {
  if (people.length === 0) return [];
  const lines = [title];
  let used = title.length;
  const fits = (text: string) => used + text.length + 1 + FOLD_ROOM <= budget;
  const add = (text: string) => {
    lines.push(text);
    used += text.length + 1;
  };
  for (const [p, person] of people.entries()) {
    const head = personLine(person);
    if (!fits(`${head}\n${billLine(person.bills[0]!, labelOf(person.bills[0]!))}`)) {
      const rest = people.slice(p);
      add(`and ${rest.length} more ${rest.length === 1 ? "person" : "people"}: ${formatCents(sum(rest.flatMap((r) => r.bills)))}`);
      break;
    }
    add(head);
    for (const [b, bill] of person.bills.entries()) {
      const line = billLine(bill, labelOf(bill));
      if (!fits(line)) {
        const rest = person.bills.slice(b);
        add(`- and ${rest.length} more: ${formatCents(sum(rest))}`);
        break;
      }
      add(line);
    }
  }
  return lines;
}

function size(lines: string[]): number {
  return lines.join("\n").length;
}

// Both directions share one reply. A link costs far more room than a bill
// without one, so "You owe" gets what "You're owed" leaves of its half, then
// "You're owed" gets back whatever that left over.
export function renderDebts(rows: BillDebt[], who: ParticipantId, everywhere: boolean, urlOf: (bill: BillDebt) => string): string {
  const where = everywhere ? "across every server" : "in this server";
  if (rows.length === 0) {
    const hint = everywhere ? "" : " Run `/debts everywhere:True` to check every server.";
    return `You're all square ${where}.${hint}`;
  }
  const mine = rows.filter((r) => r.payer === who);
  const theirs = rows.filter((r) => r.payer !== who);
  const owedToYou = byPerson(mine, (r) => ({ id: r.debtor, name: r.debtorName, isGuest: r.debtorKind === "guest" }));
  const youOwe = byPerson(theirs, (r) => ({ id: r.payer, name: r.payerName, isGuest: false }));
  const owedTitle = `**You're owed ${formatCents(sum(mine))} ${where}**`;
  const oweTitle = `**You owe ${formatCents(sum(theirs))} ${where}**`;

  const plain = (people: PersonDebts[], budget: number) => section(owedTitle, people, budget, billLabel);
  const linked = (people: PersonDebts[], budget: number) => section(oweTitle, people, budget, (b) => `[${billLabel(b)}](<${urlOf(b)}>)`);
  const roomFor = (other: string[]) => MAX_CONTENT - size(other) - SECTION_GAP.length;
  const owe = linked(youOwe, roomFor(plain(owedToYou, MAX_CONTENT / 2)));
  const owed = plain(owedToYou, roomFor(owe));
  return [owed, owe].filter((part) => part.length > 0).map((part) => part.join("\n")).join(SECTION_GAP);
}

// Outside a server there is no "this server" to scope to, so it rolls up. The
// reply is private because each link in it belongs to the person who asked;
// like Open the split's, they last 30 minutes, and the next /debts makes new.
export const debtsCommand: InteractionHandler = async (body, env, _ctx, origin) => {
  const who = invokerOf(body);
  if (!who) return privately("That action is not supported.");
  const everywhere = booleanOption(body, "everywhere") === true || !body.guild_id;
  const rows = await debts(env.DB, who.id, everywhere ? undefined : body.guild_id);
  const now = Date.now();
  const tokens = new Map(
    await Promise.all(
      rows
        .filter((r) => r.payer !== who.id)
        .map(async (r) => [r.billId, await mintToken(r.billId, who.id, env.TOKEN_SIGNING_KEY, now)] as const),
    ),
  );
  return privately(renderDebts(rows, who.id, everywhere, (b) => `${origin}/b/${encodeURIComponent(b.billId)}?t=${tokens.get(b.billId)}`));
};
