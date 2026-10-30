import type { AmountChange, BillRow, Participant } from "../db/bills";
import { formatCents, formatDate } from "../format";
import { debtorOf, groupByDebtor, groupOf } from "../money/debtors";
import type { Cents, ParticipantId, Share } from "../money/types";
import { escapeMarkdown, groupName } from "./render";

// What the bot says in the channel when something changes on the page. A
// payment or a reopen moves what people owe, and an edit to the bill message
// notifies nobody, so each of these is posted as a new message.

// Discord refuses a message over 2000 characters.
const MAX_CONTENT = 2000;
const MAX_BILL_NAME = 80;
const MAX_NAME = 40;
// A Venmo note is short, and the bill name is all the note says.
export const MAX_NOTE = 60;

// By code point, so a cut never splits an emoji into a lone surrogate.
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

// Clipped before anything escapes it, so a cut never strands a backslash.
export function billName(bill: BillRow): string {
  const date = formatDate(bill.billDate);
  return `${clip(bill.place?.trim() || "dinner", MAX_BILL_NAME)}${date ? `, ${date}` : ""}`;
}

export function nameOf(participants: Participant[], id: string): string {
  const name = participants.find((p) => p.id === id)?.displayName;
  return name ? escapeMarkdown(name) : "the person who paid";
}

export function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

// "Marcus paid $44.46 and now owes $41.10, so Gavin owes Marcus $3.36." Names
// rather than pronouns, since the bot knows nobody's.
function changeLine(change: AmountChange, participants: Participant[], payerId: string): string {
  const who = nameOf(participants, change.participant);
  const payer = nameOf(participants, payerId);
  const balance = change.nowCents - change.settledCents;
  const settle =
    balance < 0
      ? `so ${payer} owes ${who} ${formatCents(-balance)}.`
      : balance > 0
        ? `so ${who} owes ${payer} ${formatCents(balance)} more.`
        : "so they're square.";
  return `${who} paid ${formatCents(change.settledCents)} and now owes ${formatCents(change.nowCents)}, ${settle}`;
}

function announcement(lead: string, changes: AmountChange[], participants: Participant[], payerId: string): string {
  return clip([lead, ...changes.map((c) => `- ${changeLine(c, participants, payerId)}`)].join("\n"), MAX_CONTENT);
}

// Only said when someone who already paid now owes a different amount; a
// first confirm changes nothing anyone was told.
export function reconfirmNotice(bill: BillRow, participants: Participant[], changes: AmountChange[]): string | null {
  if (changes.length === 0) return null;
  const payer = nameOf(participants, bill.payerId);
  return announcement(
    `${payer} confirmed ${escapeMarkdown(billName(bill))} again, and the amounts changed for people who had already paid:`,
    changes,
    participants,
    bill.payerId,
  );
}

// The payer reopening to fix their own bill is only news when it moves what
// someone already paid against. Anyone else reopening it always is: they are
// telling the payer something is wrong.
export function reopenNotice(
  bill: BillRow,
  participants: Participant[],
  changes: AmountChange[],
  by: ParticipantId,
): string | null {
  const payer = nameOf(participants, bill.payerId);
  const forBill = escapeMarkdown(billName(bill));
  const asItStands = changes.length > 0 ? " As it stands now:" : "";
  if (by === bill.payerId) {
    if (changes.length === 0) return null;
    return announcement(
      `${payer} reopened ${forBill} to fix it, so paying is paused until it's confirmed again.${asItStands}`,
      changes,
      participants,
      bill.payerId,
    );
  }
  return announcement(
    `${nameOf(participants, by)} said something's wrong on ${forBill}, so paying is paused until ${payer} fixes it and confirms again.${asItStands}`,
    changes,
    participants,
    bill.payerId,
  );
}

// `leftCents` is what the person has left after this payment.
export function paymentNotice(bill: BillRow, participants: Participant[], who: ParticipantId, cents: Cents, leftCents: Cents): string {
  const after = leftCents > 0 ? `, and has ${formatCents(leftCents)} left to pay.` : ", and is all paid up.";
  return clip(
    `${nameOf(participants, who)} paid ${nameOf(participants, bill.payerId)} ${formatCents(cents)} for ${escapeMarkdown(billName(bill))}${after}`,
    MAX_CONTENT,
  );
}

// A guest's payment was toward what the member who added them owes, so the
// balance told is that member's. `leftCents` is theirs, after the undo.
export function undoNotice(
  bill: BillRow,
  participants: Participant[],
  paidBy: ParticipantId,
  cents: Cents,
  leftCents: Cents,
): string {
  const person = participants.find((p) => p.id === paidBy);
  const answers = nameOf(participants, person ? debtorOf(person, bill.payerId) : paidBy);
  const after = leftCents > 0 ? `${answers} has ${formatCents(leftCents)} left to pay.` : `${answers} is still all paid up.`;
  return clip(
    `${nameOf(participants, bill.payerId)} removed ${nameOf(participants, paidBy)}'s ${formatCents(cents)} payment on ` +
      `${escapeMarkdown(billName(bill))}. ${after}`,
    MAX_CONTENT,
  );
}

// What forgiving a share, or taking that back, is announced as. The amount
// named is the one share that changed; what follows is what the member who
// answers for it owes now, with any guests named the way the owe card names
// the pair, since that row is where the number shows. Null when the share is
// not on the bill.
export function pardonNotice(
  bill: BillRow,
  participants: Participant[],
  shares: Share[],
  participantId: string,
  pardoned: boolean,
): string | null {
  const target = participants.find((p) => p.id === participantId);
  const share = shares.find((s) => s.participant === participantId);
  const group = target && groupOf(groupByDebtor(shares, participants, bill.payerId), debtorOf(target, bill.payerId));
  if (!target || !share || !group) return null;

  const names = new Map(participants.map((p) => [p.id, escapeMarkdown(clip(p.displayName, MAX_NAME))]));
  const payer = names.get(bill.payerId) ?? "The person who paid";
  const whose = `${names.get(target.id)}'s ${formatCents(share.owedCents)} for ${escapeMarkdown(billName(bill))}`;
  // "Dani, including Sam" is an aside mid-sentence, so it closes with a comma.
  const who = groupName(group, names) + (group.guests.length > 0 ? "," : "");
  if (pardoned) {
    return clip(`${payer} forgave ${whose}, so ${who} owes ${group.owedCents === 0 ? "nothing" : formatCents(group.owedCents)}.`, MAX_CONTENT);
  }
  // "Again" only when the row is back to what it was before any pardon.
  const stillForgiven = [group.own, ...group.guests].some((s) => s?.pardoned);
  return clip(`${payer} took back forgiving ${whose}, so ${who} owes ${formatCents(group.owedCents)}${stillForgiven ? "" : " again"}.`, MAX_CONTENT);
}

// What a guest paying the payer directly, or that being taken back, is
// announced as, worded like a member's payment and its undo so the channel
// reads one way. `leftCents` is what the person answering for the guest has left.
export function guestPaidNotice(
  bill: BillRow,
  participants: Participant[],
  guestId: string,
  cents: Cents,
  paid: boolean,
  leftCents: Cents,
): string | null {
  const guest = participants.find((p) => p.id === guestId);
  if (!guest) return null;
  const debtor = debtorOf(guest, bill.payerId);
  const payer = nameOf(participants, bill.payerId);
  const who = nameOf(participants, guest.id);
  const answers = nameOf(participants, debtor);
  const forBill = escapeMarkdown(billName(bill));
  const after = leftCents > 0 ? `${answers} has ${formatCents(leftCents)} left to pay.` : `${answers} is all paid up.`;
  if (!paid) return clip(`${payer} removed ${who}'s ${formatCents(cents)} payment on ${forBill}. ${after}`, MAX_CONTENT);
  const directly = debtor === guest.id ? "" : " directly";
  return clip(`${who} paid ${payer} ${formatCents(cents)}${directly} for ${forBill}. ${after}`, MAX_CONTENT);
}
