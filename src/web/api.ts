import { Hono, type Context } from "hono";
import {
  addGuest,
  addItem,
  BillChangedError,
  BillGoneError,
  BillNotConfirmedError,
  BillNotDraftError,
  claimEverything,
  confirmBill,
  deleteBill,
  deleteItem,
  editItem,
  getBill,
  getBillSnapshot,
  getParticipants,
  getShares,
  GuestRefusedError,
  MemberRefusedError,
  NobodyClaimedError,
  NotOnRosterError,
  PardonRefusedError,
  PaymentsChangedError,
  PaymentsRecordedError,
  reassignPayer,
  removeGuest,
  removeMember,
  renameGuest,
  reopenBill,
  setBillAmounts,
  setClaim,
  setLogPlace,
  setPardon,
  splitOrphansEvenly,
  type AmountChange,
  type BillAmounts,
  type BillRow,
  type BillSnapshot,
  type Participant,
} from "../db/bills";
import { setVenmoHandle } from "../db/handles";
import { earnStamps, markStampsSeen, stampOf, type Earned } from "../db/stamps";
import {
  GuestPaidRefusedError,
  outstanding,
  recordSettlement,
  SettlementGoneError,
  SettlementRefusedError,
  setGuestPaidToHost,
  setGuestPaidToPayer,
  undoPaid,
} from "../db/settlements";
import { onePlace, postLog, removeLogPost } from "../discord/log-post";
import { guestPaidNotice, markedPaidNotice, paymentNotice, pardonNotice, reconfirmNotice, reopenNotice, undoNotice, withStamps } from "../discord/notices";
import { editBillMessage, postChannelMessage } from "../discord/rest";
import type { Env } from "../env";
import { parsePriceCents } from "../extract/schema";
import { formatCents } from "../format";
import { debtorOf } from "../money/debtors";
import type { Addon, Cents, ParticipantId } from "../money/types";
import { normalizeVenmo, VENMO_RULE } from "./paylink";
import { MAX_PLACE, removeLog, renamePost } from "./logs";
import { stateOf } from "./state";
import { readToken } from "./token";

type Ctx = Context<{ Bindings: Env }>;
type Grant = { billId: string; participantId: ParticipantId };

const LINK_REFUSED =
  "This link has expired or isn't yours. For a split, tap Open the split on the bill in Discord. For a log, run /log again, or use /profile for one you already logged.";
const NOT_FOUND = "This bill doesn't exist any more.";
const NOT_ON_BILL = "You're not on this bill. If you were there, tap Open the split on the bill in Discord to join it.";
const GONE: Partial<Record<BillRow["status"], string>> = {
  superseded: "This split was replaced by a newer one. Open the newer bill message in Discord and tap Open the split there.",
  deleted: "This split was deleted, so there's nothing left to change on it.",
};
const NOT_ON_A_LOG = "A log is just you and your items, so that can't be changed here.";
const LOG_GONE = "This log was removed, so there's nothing left to change on it.";

// $999,999.99. Far past any bill, and it keeps every sum of lines well
// inside the range where integer arithmetic stays exact.
const MAX_CENTS = 99_999_999;
const MAX_LABEL = 120;
const MAX_ADDON_LABEL = 80;
const MAX_ADDONS = 20;
const MAX_GUEST_NAME = 40;

class BadRequest extends Error {}

function bad(message: string): never {
  throw new BadRequest(message);
}

// Every answer carries a token-bound view of one person's bill, so none of it
// may sit in a shared cache.
function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function refuse(status: number, error: string): Response {
  return reply({ error }, status);
}

async function authorize(c: Ctx): Promise<Grant | null> {
  const match = /^Bearer ([^\s]+)$/.exec(c.req.header("authorization") ?? "");
  if (!match) return null;
  const grant = await readToken(match[1]!, c.env.TOKEN_SIGNING_KEY, Date.now());
  return grant && grant.billId === c.req.param("billId") ? grant : null;
}

function payerName(snapshot: BillSnapshot): string {
  return snapshot.participants.find((p) => p.id === snapshot.bill.payerId)?.displayName ?? "the person who paid";
}

function goneReason(bill: BillRow): string | undefined {
  if (bill.kind === "log" && bill.status === "deleted") return LOG_GONE;
  return GONE[bill.status];
}

function notDraft(bill: BillRow | null): Response {
  if (!bill) return refuse(409, NOT_FOUND);
  if (bill.kind === "log" && bill.status === "confirmed") return refuse(409, "This is already logged, so your items can't be changed now.");
  return refuse(
    409,
    goneReason(bill) ?? "This bill is confirmed, so it can't be changed now. Ask the person who paid to reopen it if something is wrong.",
  );
}

// Only the person logging ever opens a log. Bill tokens are per bill, so this is
// what holds that to one person even if a token for someone else ever turned up.
function logRefusal(bill: BillRow, grant: Grant): Response | null {
  return bill.kind === "log" && grant.participantId !== bill.payerId ? refuse(403, LINK_REFUSED) : null;
}

async function readBody(c: Ctx): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    bad("That request wasn't valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) bad("That request wasn't a JSON object.");
  return body as Record<string, unknown>;
}

function expectKeys(body: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) bad(`Unexpected field "${key}".`);
  for (const key of required) if (!(key in body)) bad(`Missing field "${key}".`);
}

function stampKeys(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((key) => typeof key === "string" && stampOf(key))) bad('"keys" must be a list of stamps.');
  return value as string[];
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) bad(`"${field}" must be a non-empty string.`);
  return value;
}

function label(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL) bad(`Give the line a name of 1 to ${MAX_LABEL} characters.`);
  return trimmed;
}

// The whole list, replacing what the line had. An empty list clears it.
function addons(value: unknown): Addon[] {
  if (!Array.isArray(value)) bad('"addons" must be a list.');
  if (value.length > MAX_ADDONS) bad(`A dish takes up to ${MAX_ADDONS} add-ons.`);
  return value.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad("Each add-on needs a name and a price.");
    const addon = raw as Record<string, unknown>;
    expectKeys(addon, ["label", "price"]);
    // One line, so a newline never reaches the Discord message.
    const name = typeof addon.label === "string" ? addon.label.replace(/\s+/g, " ").trim() : "";
    if (name.length === 0 || name.length > MAX_ADDON_LABEL) bad(`Give each add-on a name of 1 to ${MAX_ADDON_LABEL} characters.`);
    return { label: name, cents: cents(addon.price, "add-on price", { signed: true }) };
  });
}

// Decimal strings through the extraction's own strict parser: "12.50" becomes
// 1250 by reading digits, never by multiplying a float.
function cents(value: unknown, what: string, options: { signed: boolean }): Cents {
  const parsed = parsePriceCents(value);
  if (parsed === null || Math.abs(parsed) > MAX_CENTS || (!options.signed && parsed < 0)) {
    bad(`Enter the ${what} as a plain amount like 12.50${options.signed ? " (with a minus sign for money off)" : ""}.`);
  }
  return parsed;
}

// Hundredths of a percent, read with the same two-decimal parser as money: a
// JSON number is turned back into its shortest decimal spelling first, so 18.5
// arrives as "18.5" and never takes part in float arithmetic.
function basisPoints(value: unknown): number {
  const spelled = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  const parsed = parsePriceCents(spelled);
  if (parsed === null || parsed < 0 || parsed > 100_00) bad("Enter the tip percentage as a number from 0 to 100, like 18 or 18.5.");
  return parsed;
}

async function loadDraft(c: Ctx, grant: Grant): Promise<BillSnapshot | Response> {
  const snapshot = await getBillSnapshot(c.env.DB, grant.billId);
  if (!snapshot) return refuse(404, NOT_FOUND);
  if (snapshot.bill.status !== "draft") return notDraft(snapshot.bill);
  return logRefusal(snapshot.bill, grant) ?? snapshot;
}

async function currentState(c: Ctx, grant: Grant): Promise<Response> {
  const snapshot = await getBillSnapshot(c.env.DB, grant.billId);
  if (!snapshot) return refuse(404, NOT_FOUND);
  if (snapshot.bill.kind === "log" && grant.participantId !== snapshot.bill.payerId) return refuse(403, LINK_REFUSED);
  const gone = goneReason(snapshot.bill);
  if (gone) return refuse(410, gone);
  return reply(await stateOf(c.env.DB, snapshot, grant.participantId));
}

// The Discord message is only a summary of the page, so it follows on the
// coalesced timer and a failed edit is logged rather than failing the write.
function refreshMessage(c: Ctx, bill: BillRow): void {
  c.executionCtx.waitUntil(editBillMessage(bill, c.env).catch((error) => console.error("could not update the bill message", error)));
}

// A new message in the channel, unlike an edit, notifies people, so this is
// how a payment or a reopen reaches everyone. A failed post is logged and the
// write stands.
function announce(c: Ctx, bill: BillRow, content: string | null): void {
  if (!content) return;
  c.executionCtx.waitUntil(
    postChannelMessage(bill.channelId, { content, allowed_mentions: { parse: [] } }, c.env).catch((error) =>
      console.error("could not post to the channel", error),
    ),
  );
}

// A stamp follows a write that has already landed, so a failure here is logged
// and costs nothing: the same rows earn it on that person's next bill.
async function earn(env: Env, bill: BillRow, people: ParticipantId[], options?: { forgave?: boolean }): Promise<Earned[]> {
  try {
    return await earnStamps(env.DB, bill, people, options);
  } catch (error) {
    console.error("could not award stamps", error);
    return [];
  }
}

function membersOf(snapshot: BillSnapshot): ParticipantId[] {
  return snapshot.participants.filter((p) => p.kind === "member").map((p) => p.id);
}

async function commit(c: Ctx, grant: Grant, bill: BillRow, write: () => Promise<number>): Promise<Response> {
  try {
    await write();
  } catch (error) {
    if (error instanceof BillNotDraftError) return notDraft(await getBill(c.env.DB, grant.billId));
    throw error;
  }
  refreshMessage(c, bill);
  return currentState(c, grant);
}

// The bill as it is now, for a write that works on a confirmed bill as well
// as a draft. A bill that was replaced or deleted takes no more writes.
async function loadLive(c: Ctx, grant: Grant): Promise<BillSnapshot | Response> {
  const snapshot = await getBillSnapshot(c.env.DB, grant.billId);
  if (!snapshot) return refuse(404, NOT_FOUND);
  const gone = goneReason(snapshot.bill);
  if (gone) return refuse(409, gone);
  return logRefusal(snapshot.bill, grant) ?? snapshot;
}

function route(handler: (c: Ctx, grant: Grant) => Promise<Response>) {
  return async (c: Ctx): Promise<Response> => {
    const grant = await authorize(c);
    if (!grant) return refuse(403, LINK_REFUSED);
    try {
      return await handler(c, grant);
    } catch (error) {
      if (error instanceof BadRequest) return refuse(400, error.message);
      throw error;
    }
  };
}

// Everything about other people and money owed. A log has neither, so no write
// here should ever reach one, whatever the page offers.
function splitRoute(handler: (c: Ctx, grant: Grant) => Promise<Response>) {
  return route(async (c, grant) => {
    const bill = await getBill(c.env.DB, grant.billId);
    return bill?.kind === "log" ? refuse(409, NOT_ON_A_LOG) : handler(c, grant);
  });
}

export const api = new Hono<{ Bindings: Env }>();

api.get("/:billId/state", route(currentState));

// Marked when the sheet appears, so a dropped network means seeing it twice
// rather than never. The stamp is the viewer's, whatever bill the link is for.
api.post(
  "/:billId/stamps/seen",
  route(async (c, grant) => {
    const body = await readBody(c);
    expectKeys(body, ["keys"]);
    const bill = await getBill(c.env.DB, grant.billId);
    if (!bill) return refuse(404, NOT_FOUND);
    await markStampsSeen(c.env.DB, bill.guildId, grant.participantId, stampKeys(body.keys));
    return reply({ seen: true });
  }),
);

api.post(
  "/:billId/claim",
  route(async (c, grant) => {
    const body = await readBody(c);
    expectKeys(body, ["itemId", "participantId", "claimed"]);
    const itemId = text(body.itemId, "itemId");
    const participantId = text(body.participantId, "participantId");
    const claimed = body.claimed;
    if (typeof claimed !== "boolean") bad('"claimed" must be true or false.');

    const snapshot = await loadDraft(c, grant);
    if (snapshot instanceof Response) return snapshot;
    const isPayer = grant.participantId === snapshot.bill.payerId;
    const onBill = (id: ParticipantId) => snapshot.participants.some((p) => p.id === id);
    // A guest can't tap anything, so the member who added them taps for them.
    const ownGuest = snapshot.participants.some((p) => p.id === participantId && p.kind === "guest" && p.addedBy === grant.participantId);

    if (!isPayer && participantId !== grant.participantId && !ownGuest) {
      return refuse(
        403,
        `Only ${payerName(snapshot)} can tap other people onto a line. Tap your own chip for what you had, or a guest's you added.`,
      );
    }
    if (!onBill(participantId)) {
      return participantId === grant.participantId ? refuse(403, NOT_ON_BILL) : refuse(400, "That person isn't on this bill.");
    }
    if (!snapshot.input.items.some((i) => i.id === itemId)) return refuse(404, "That line isn't on the bill any more.");

    return commit(c, grant, snapshot.bill, () => setClaim(c.env.DB, grant.billId, itemId, participantId, claimed));
  }),
);

api.post(
  "/:billId/everything",
  route(async (c, grant) => {
    const body = await readBody(c);
    expectKeys(body, ["claimed"]);
    const claimed = body.claimed;
    if (typeof claimed !== "boolean") bad('"claimed" must be true or false.');

    const snapshot = await loadDraft(c, grant);
    if (snapshot instanceof Response) return snapshot;
    if (snapshot.bill.kind !== "log") return refuse(409, "Tap the lines you had. Only a log takes everything at once.");
    return commit(c, grant, snapshot.bill, () => claimEverything(c.env.DB, grant.billId, grant.participantId, claimed));
  }),
);

api.post(
  "/:billId/item",
  splitRoute(async (c, grant) => {
    const body = await readBody(c);
    let write: (db: D1Database) => Promise<number>;
    let itemId: string | null = null;
    switch (body.op) {
      case "add": {
        expectKeys(body, ["op", "label", "price"]);
        const item = { id: crypto.randomUUID(), label: label(body.label), cents: cents(body.price, "price", { signed: true }) };
        write = (db) => addItem(db, grant.billId, { ...item, source: "manual", confidence: null });
        break;
      }
      case "edit": {
        // "price" is the dish's own price. The line's total adds its add-ons.
        expectKeys(body, ["op", "itemId"], ["label", "price", "addons"]);
        if (!("label" in body) && !("price" in body) && !("addons" in body)) bad("Change the line's name, price or add-ons.");
        const id = (itemId = text(body.itemId, "itemId"));
        const change = {
          label: "label" in body ? label(body.label) : undefined,
          baseCents: "price" in body ? cents(body.price, "price", { signed: true }) : undefined,
          addons: "addons" in body ? addons(body.addons) : undefined,
        };
        write = (db) => editItem(db, grant.billId, id, change);
        break;
      }
      case "delete": {
        expectKeys(body, ["op", "itemId"]);
        const id = (itemId = text(body.itemId, "itemId"));
        write = (db) => deleteItem(db, grant.billId, id);
        break;
      }
      default:
        bad('"op" must be "add", "edit" or "delete".');
    }

    const snapshot = await loadDraft(c, grant);
    if (snapshot instanceof Response) return snapshot;
    if (grant.participantId !== snapshot.bill.payerId) {
      return refuse(403, `Only ${payerName(snapshot)} can change the lines, because they paid. Tap your own chip for what you had.`);
    }
    if (itemId !== null && !snapshot.input.items.some((i) => i.id === itemId)) {
      return refuse(404, "That line isn't on the bill any more.");
    }
    return commit(c, grant, snapshot.bill, () => write(c.env.DB));
  }),
);

const ON_BILL_FIRST = "That person isn't on this bill. They join it by tapping Open the split in Discord.";

// A separate write from the amounts, because handing the bill over also hands
// over the right to make every other change.
async function changePayer(c: Ctx, grant: Grant, body: Record<string, unknown>): Promise<Response> {
  if (Object.keys(body).length > 1) bad("Change who paid on its own, then the amounts.");
  const to = text(body.payer, "payer");

  const snapshot = await loadDraft(c, grant);
  if (snapshot instanceof Response) return snapshot;
  if (grant.participantId !== snapshot.bill.payerId) {
    return refuse(403, `Only ${payerName(snapshot)} can hand the bill to someone else.`);
  }
  const target = snapshot.participants.find((p) => p.id === to);
  if (!target) return refuse(400, ON_BILL_FIRST);
  if (target.kind !== "member") return refuse(400, "A guest can't be the one who paid. Pick someone with a Discord account.");
  try {
    return await commit(c, grant, snapshot.bill, () => reassignPayer(c.env.DB, grant.billId, to));
  } catch (error) {
    // Taken off the bill between the read above and the write.
    if (error instanceof NotOnRosterError) return refuse(400, ON_BILL_FIRST);
    if (!(error instanceof PaymentsRecordedError)) throw error;
    return refuse(
      409,
      `People have already paid ${payerName(snapshot)} on this bill, so it can't be handed to someone else now. ` +
        "Their payments would end up counted toward the wrong person.",
    );
  }
}

// A log is the one kind of bill whose name its owner types in, since the read
// can miss it and the post says it to the whole channel.
async function changePlace(c: Ctx, grant: Grant, body: Record<string, unknown>): Promise<Response> {
  if (Object.keys(body).length > 1) bad("Change the name on its own.");
  const place = typeof body.place === "string" ? onePlace(body.place) : "";
  if (place.length === 0) bad(`Give this place a name of 1 to ${MAX_PLACE} characters.`);

  const snapshot = await loadLive(c, grant);
  if (snapshot instanceof Response) return snapshot;
  const { bill } = snapshot;
  if (bill.kind !== "log") return refuse(409, "Only a log takes a new name.");
  if (!(await setLogPlace(c.env.DB, grant.billId, place))) return refuse(409, LOG_GONE);
  if (bill.status === "confirmed") c.executionCtx.waitUntil(renamePost({ ...bill, place }, c.env));
  return currentState(c, grant);
}

api.patch(
  "/:billId",
  route(async (c, grant) => {
    const body = await readBody(c);
    expectKeys(body, [], ["discount", "tax", "tip", "tipPercent", "printedTotal", "payer", "place"]);
    if (Object.keys(body).length === 0) bad("Nothing to change.");
    if ("place" in body) return changePlace(c, grant, body);
    if ((await getBill(c.env.DB, grant.billId))?.kind === "log") return refuse(409, NOT_ON_A_LOG);
    if ("payer" in body) return changePayer(c, grant, body);
    if ("tip" in body && "tipPercent" in body) bad("Enter the tip as dollars or as a percentage, not both.");

    const amounts: BillAmounts = {};
    if ("discount" in body) amounts.discountCents = cents(body.discount, "discount", { signed: false });
    if ("tax" in body) amounts.taxCents = cents(body.tax, "tax", { signed: false });
    if ("tip" in body) amounts.tipCents = cents(body.tip, "tip", { signed: false });
    if ("tipPercent" in body) amounts.tipBasisPoints = basisPoints(body.tipPercent);
    if ("printedTotal" in body) {
      amounts.printedTotalCents = body.printedTotal === null ? null : cents(body.printedTotal, "printed total", { signed: false });
    }

    const snapshot = await loadDraft(c, grant);
    if (snapshot instanceof Response) return snapshot;
    if (grant.participantId !== snapshot.bill.payerId) {
      return refuse(403, `Only ${payerName(snapshot)} can change the discount, tax, tip and total, because they paid.`);
    }
    // Checked against the lines as they stand. A line removed later can still
    // leave it larger, and the split copes, but nobody should type it that way.
    const subtotal = snapshot.input.items.reduce((sum, item) => sum + item.cents, 0);
    if (amounts.discountCents !== undefined && amounts.discountCents > Math.max(0, subtotal)) {
      return refuse(400, "Discount is more than the subtotal.");
    }
    return commit(c, grant, snapshot.bill, () => setBillAmounts(c.env.DB, grant.billId, amounts));
  }),
);

function nameTaken(existing: string): string {
  return `${existing} is already on this bill. Give the guest a name that tells them apart, like one with an initial.`;
}

function guestName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length === 0 || name.length > MAX_GUEST_NAME) bad(`Give the guest a name of 1 to ${MAX_GUEST_NAME} characters.`);
  return name;
}

// Two people with one name would make every row and payment ambiguous. The
// write checks again; this answers with the name already there.
function nameClash(snapshot: BillSnapshot, name: string, except: ParticipantId | null = null): Response | null {
  const clash = snapshot.participants.find((p) => p.id !== except && p.displayName.trim().toLowerCase() === name.toLowerCase());
  return clash ? refuse(400, nameTaken(clash.displayName)) : null;
}

const GUEST_GONE = "That guest isn't on this bill any more.";

// A guest is somebody at the table without a Discord account. Whoever adds
// them answers for what they had, so there is nobody to name but the viewer.
api.post(
  "/:billId/guest",
  splitRoute(async (c, grant) => {
    const body = await readBody(c);
    expectKeys(body, ["name"]);
    const name = guestName(body.name);

    const snapshot = await loadDraft(c, grant);
    if (snapshot instanceof Response) return snapshot;
    if (!snapshot.participants.some((p) => p.id === grant.participantId && p.kind === "member")) return refuse(403, NOT_ON_BILL);
    const clash = nameClash(snapshot, name);
    if (clash) return clash;

    try {
      return await commit(c, grant, snapshot.bill, () =>
        addGuest(c.env.DB, grant.billId, { id: `guest-${crypto.randomUUID()}`, displayName: name, addedBy: grant.participantId }),
      );
    } catch (error) {
      if (!(error instanceof GuestRefusedError)) throw error;
      // Someone changed the roster between the read above and the write.
      return error.reason === "name-taken" ? refuse(400, nameTaken(name)) : refuse(403, NOT_ON_BILL);
    }
  }),
);

// The member who added a guest looks after them, and the payer can tidy up
// anyone's. `action` finishes the sentence "Only X or Y can ...".
function guestFor(
  snapshot: BillSnapshot,
  grant: Grant,
  guestId: ParticipantId,
  action: string,
): Participant | Response {
  const guest = snapshot.participants.find((p) => p.id === guestId && p.kind === "guest");
  if (!guest) return refuse(404, GUEST_GONE);
  if (grant.participantId !== guest.addedBy && grant.participantId !== snapshot.bill.payerId) {
    const adder = snapshot.participants.find((p) => p.id === guest.addedBy)?.displayName ?? "whoever added them";
    const or = guest.addedBy === snapshot.bill.payerId ? "" : ` or ${payerName(snapshot)}`;
    return refuse(403, `Only ${adder}, who added ${guest.displayName},${or} can ${action}.`);
  }
  return guest;
}

api.patch(
  "/:billId/guest/:guestId",
  splitRoute(async (c, grant) => {
    const body = await readBody(c);
    expectKeys(body, ["name"]);
    const name = guestName(body.name);

    const snapshot = await loadDraft(c, grant);
    if (snapshot instanceof Response) return snapshot;
    const guest = guestFor(snapshot, grant, c.req.param("guestId") ?? "", "rename them");
    if (guest instanceof Response) return guest;
    const clash = nameClash(snapshot, name, guest.id);
    if (clash) return clash;

    try {
      return await commit(c, grant, snapshot.bill, () => renameGuest(c.env.DB, grant.billId, guest.id, name));
    } catch (error) {
      if (!(error instanceof GuestRefusedError)) throw error;
      return error.reason === "name-taken" ? refuse(400, nameTaken(name)) : refuse(404, GUEST_GONE);
    }
  }),
);

api.delete(
  "/:billId/guest/:guestId",
  splitRoute(async (c, grant) => {
    const snapshot = await loadDraft(c, grant);
    if (snapshot instanceof Response) return snapshot;
    const guest = guestFor(snapshot, grant, c.req.param("guestId") ?? "", "take them off");
    if (guest instanceof Response) return guest;

    try {
      return await commit(c, grant, snapshot.bill, () => removeGuest(c.env.DB, grant.billId, guest.id));
    } catch (error) {
      if (!(error instanceof GuestRefusedError)) throw error;
      if (error.reason !== "paid") return refuse(404, GUEST_GONE);
      // Only on a reopened bill, whose payments stay put until it is confirmed
      // again; taking the guest off their lines leaves them owing nothing.
      return refuse(
        409,
        `There's already a payment toward ${guest.displayName}'s share on this bill, so they can't be taken off now. ` +
          `Take ${guest.displayName} off their lines instead, and their share drops to nothing.`,
      );
    }
  }),
);

const MEMBER_REFUSED: Record<Exclude<MemberRefusedError["reason"], "no-member" | "payer">, (name: string) => string> = {
  guests: (name) => `${name} brought a guest. Take the guest off first.`,
  paid: (name) => `${name} has already paid on this bill, so they stay on it.`,
};

// Only the payer tidies the roster, and only while the bill is a draft: once
// it is confirmed, everyone on it was told an amount.
api.delete(
  "/:billId/member/:memberId",
  splitRoute(async (c, grant) => {
    const snapshot = await loadDraft(c, grant);
    if (snapshot instanceof Response) return snapshot;
    if (grant.participantId !== snapshot.bill.payerId) {
      return refuse(403, `Only ${payerName(snapshot)} can take people off the bill, because they paid.`);
    }
    const memberId = c.req.param("memberId") ?? "";
    try {
      return await commit(c, grant, snapshot.bill, () => removeMember(c.env.DB, grant.billId, memberId));
    } catch (error) {
      if (!(error instanceof MemberRefusedError)) throw error;
      if (error.reason === "no-member") return refuse(404, "That person isn't on this bill any more.");
      if (error.reason === "payer") return refuse(400, "You paid the bill, so you stay on it.");
      const name = snapshot.participants.find((p) => p.id === memberId)?.displayName ?? "That person";
      return refuse(409, MEMBER_REFUSED[error.reason](name));
    }
  }),
);

// The username belongs to the person, not the bill, so this changes nothing on
// the bill and bumps no revision: every page reads it fresh on its next poll.
// The bill only answers who is asking. The token names them, so nobody can set
// another person's. It doesn't check they own the Venmo account, and can't:
// Venmo has no API for that.
api.post(
  "/:billId/venmo",
  splitRoute(async (c, grant) => {
    const body = await readBody(c);
    expectKeys(body, ["username"]);
    const username = typeof body.username === "string" ? normalizeVenmo(body.username) : null;
    if (username === null) bad(VENMO_RULE);

    const snapshot = await loadLive(c, grant);
    if (snapshot instanceof Response) return snapshot;
    if (!snapshot.participants.some((p) => p.id === grant.participantId && p.kind === "member")) return refuse(403, NOT_ON_BILL);

    await setVenmoHandle(c.env.DB, grant.participantId, username);
    return currentState(c, grant);
  }),
);

// Said in the channel like any payment, so the member who added the guest
// hears that part of what they owe was paid. A failed post is logged and the
// mark stands.
async function announceGuestPaid(env: Env, billId: string, guestId: ParticipantId, cents: Cents, paid: boolean, earned: Earned[]): Promise<void> {
  const [bill, participants, standing] = await Promise.all([getBill(env.DB, billId), getParticipants(env.DB, billId), outstanding(env.DB, billId)]);
  const guest = participants.find((p) => p.id === guestId);
  if (!bill || !guest) return;
  const row = standing.find((o) => o.participant === debtorOf(guest, bill.payerId));
  const content = withStamps(guestPaidNotice(bill, participants, guestId, cents, paid, row ? row.owedCents - row.settledCents : 0), participants, earned);
  if (!content) return;
  await postChannelMessage(bill.channelId, { content, allowed_mentions: { parse: [] } }, env);
}

// Two marks on one endpoint, told apart by who sets them. The payer's means
// the guest paid the payer directly and is a payment; the adder's means the
// guest paid the adder and is bookkeeping between the two of them. When the
// payer added the guest, both are the payer's, and so is the meaning.
api.post(
  "/:billId/guest/:guestId/paid",
  splitRoute(async (c, grant) => {
    const body = await readBody(c);
    expectKeys(body, ["paid"]);
    const paid = body.paid;
    if (typeof paid !== "boolean") bad('"paid" must be true or false.');

    const snapshot = await getBillSnapshot(c.env.DB, grant.billId);
    if (!snapshot) return refuse(404, NOT_FOUND);
    const gone = GONE[snapshot.bill.status];
    if (gone) return refuse(409, gone);
    const guest = guestFor(snapshot, grant, c.req.param("guestId") ?? "", "mark them paid");
    if (guest instanceof Response) return guest;
    const payer = payerName(snapshot);
    if (snapshot.bill.status !== "confirmed") {
      return refuse(409, "This bill isn't confirmed, so nobody owes anything on it yet. Mark the guest paid once it's confirmed.");
    }
    const debtor = debtorOf(guest, snapshot.bill.payerId);
    const answers = snapshot.participants.find((p) => p.id === debtor)?.displayName ?? guest.displayName;

    try {
      return await commit(c, grant, snapshot.bill, async () => {
        if (grant.participantId !== snapshot.bill.payerId) {
          return (await setGuestPaidToHost(c.env.DB, grant.billId, guest.id, paid)) ?? snapshot.bill.revision;
        }
        const done = await setGuestPaidToPayer(c.env.DB, grant.billId, guest.id, paid);
        if (done === null) return snapshot.bill.revision;
        const earned = paid ? await earn(c.env, snapshot.bill, []) : [];
        c.executionCtx.waitUntil(
          announceGuestPaid(c.env, grant.billId, guest.id, done.cents, paid, earned).catch((error) =>
            console.error("could not announce the guest's payment", error),
          ),
        );
        return done.revision;
      });
    } catch (error) {
      if (!(error instanceof GuestPaidRefusedError)) throw error;
      switch (error.reason) {
        case "not-confirmed":
          return refuse(409, "This bill isn't confirmed any more, so paying is paused. Mark the guest paid once it's confirmed again.");
        case "no-guest":
          return refuse(404, GUEST_GONE);
        case "no-share":
        case "nothing-owed":
          return refuse(409, `${guest.displayName} has nothing to pay on this bill.`);
        case "forgiven":
          return refuse(409, `${payer} forgave ${guest.displayName}'s share, so there's nothing for them to pay.`);
        case "covered":
          // The money already reached the payer through the adder; counting
          // the guest's too would have the payer owing someone back.
          return refuse(
            409,
            `${answers} has already paid you ${guest.displayName}'s share, so it can't be paid twice. ` +
              `If ${guest.displayName} paid you instead, undo ${answers}'s payment under Payments first.`,
          );
        case "changed":
          return refuse(409, "The bill changed while you were doing that. Look again and try once more.");
      }
    }
  }),
);

// Someone was already told a number, and the owe card's "forgiven" arrives as
// an edit, which Discord tells nobody about; so the change is also said in the
// channel. The rows are read after the write, so the amounts are the ones now
// in force. Like a failed card edit, a failed post is logged and the pardon
// stands.
async function announcePardon(env: Env, billId: string, participantId: ParticipantId, pardoned: boolean, earned: Earned[]): Promise<void> {
  const [bill, participants, shares] = await Promise.all([
    getBill(env.DB, billId),
    getParticipants(env.DB, billId),
    getShares(env.DB, billId),
  ]);
  const content = bill && withStamps(pardonNotice(bill, participants, shares, participantId, pardoned), participants, earned);
  if (!bill || !content) return;
  await postChannelMessage(bill.channelId, { content, allowed_mentions: { parse: [] } }, env);
}

// Forgiving waives a frozen amount, so it is only offered once the bill is
// confirmed; the payer absorbs it and nobody else's share moves.
api.post(
  "/:billId/pardon",
  splitRoute(async (c, grant) => {
    const body = await readBody(c);
    expectKeys(body, ["participantId", "pardoned"]);
    const participantId = text(body.participantId, "participantId");
    const pardoned = body.pardoned;
    if (typeof pardoned !== "boolean") bad('"pardoned" must be true or false.');

    const snapshot = await getBillSnapshot(c.env.DB, grant.billId);
    if (!snapshot) return refuse(404, NOT_FOUND);
    const gone = GONE[snapshot.bill.status];
    if (gone) return refuse(409, gone);
    const payer = payerName(snapshot);
    if (grant.participantId !== snapshot.bill.payerId) {
      return refuse(403, `Only ${payer} can forgive someone's share, because it's their money.`);
    }
    if (snapshot.bill.status !== "confirmed") {
      return refuse(409, "This bill isn't confirmed yet, so there's no amount to forgive. Confirm it first.");
    }
    const target = snapshot.participants.find((p) => p.id === participantId);
    if (!target) return refuse(400, "That person isn't on this bill.");
    const debtor = debtorOf(target, snapshot.bill.payerId);
    if (debtor === snapshot.bill.payerId) return refuse(400, "That's your own share, so there's nobody to forgive.");

    try {
      return await commit(c, grant, snapshot.bill, async () => {
        const revision = await setPardon(c.env.DB, grant.billId, participantId, pardoned);
        if (revision === null) return snapshot.bill.revision;
        const earned = pardoned ? await earn(c.env, snapshot.bill, [], { forgave: true }) : [];
        c.executionCtx.waitUntil(
          announcePardon(c.env, grant.billId, participantId, pardoned, earned).catch((error) => console.error("could not announce the pardon", error)),
        );
        return revision;
      });
    } catch (error) {
      if (!(error instanceof PardonRefusedError)) throw error;
      const answers = snapshot.participants.find((p) => p.id === debtor)?.displayName ?? "They";
      switch (error.reason) {
        case "not-confirmed":
          return refuse(409, "This bill isn't confirmed any more, so there's no amount to forgive. Confirm it again first.");
        case "no-share":
          return refuse(400, `${target.displayName} has no share on this bill, so there's nothing to forgive.`);
        case "payer":
          return refuse(400, "That share is already yours, so there's nobody to forgive.");
        case "paid":
          // Forgiving on top of a payment would leave the payment measured
          // against an amount nobody owes, so the payments go first.
          return refuse(
            409,
            `There's already a payment toward what ${answers} owes on this bill, so ${target.id === debtor ? "their" : `${target.displayName}'s`} ` +
              "share can't be forgiven or brought back now. Undo the payment under Payments first.",
          );
        case "changed":
          return refuse(409, "The bill changed while you were doing that. Look again and try once more.");
      }
    }
  }),
);

const CONFIRM_REFUSED = {
  stale: "The bill changed while you were looking. Check it and confirm again.",
  unreconciled: "Line items do not add up to total!",
  unclaimed: "Some lines have nobody on them yet.",
  alone: "Add someone, or use /log.",
  "receipt-taken": "This receipt was already split.",
  "receipt-logged": "This receipt was already logged.",
  "no-place": "Add the name of this place.",
  "nothing-picked": "Pick what you had.",
  "over-total": "Your items add up to more than the receipt's total.",
};

// Save, then post, inside the tap, so the page can say if the post failed.
async function finishLog(c: Ctx, grant: Grant, earned: Earned[]): Promise<Response> {
  const bill = await getBill(c.env.DB, grant.billId);
  if (!bill) return refuse(404, NOT_FOUND);
  await postLog(bill, c.env, earned);
  return currentState(c, grant);
}

// `revision` is the bill the payer looked at: anything that changed since
// means they would be agreeing to numbers they never saw. `splitUnclaimed`
// puts every line nobody claimed on everyone who claimed something first.
api.post(
  "/:billId/confirm",
  route(async (c, grant) => {
    const body = await readBody(c);
    expectKeys(body, ["revision"], ["splitUnclaimed"]);
    const revision = body.revision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision)) bad('"revision" must be a whole number.');
    const splitUnclaimed = body.splitUnclaimed ?? false;
    if (typeof splitUnclaimed !== "boolean") bad('"splitUnclaimed" must be true or false.');

    const snapshot = await loadDraft(c, grant);
    if (snapshot instanceof Response) return snapshot;
    if (grant.participantId !== snapshot.bill.payerId) {
      return refuse(403, `Only ${payerName(snapshot)} can confirm the bill, because they paid.`);
    }
    if (splitUnclaimed && snapshot.bill.kind === "log") return refuse(409, NOT_ON_A_LOG);

    let at = revision;
    if (splitUnclaimed) {
      try {
        at = await splitOrphansEvenly(c.env.DB, grant.billId, { revision });
      } catch (error) {
        if (error instanceof BillChangedError) return refuse(409, CONFIRM_REFUSED.stale);
        if (error instanceof NobodyClaimedError) return refuse(409, "Nobody has claimed anything yet.");
        if (error instanceof BillNotDraftError) return notDraft(await getBill(c.env.DB, grant.billId));
        throw error;
      }
    }
    const result = await confirmBill(c.env.DB, grant.billId, at, grant.participantId);
    // The split's claims landed even when the confirm did not, and the
    // message has to show them either way.
    if (result.ok || splitUnclaimed) refreshMessage(c, snapshot.bill);
    if (!result.ok) {
      switch (result.reason) {
        case "not-payer":
          return refuse(403, `Only ${payerName(snapshot)} can confirm the bill, because they paid.`);
        case "not-draft":
          return notDraft(await getBill(c.env.DB, grant.billId));
        default:
          return refuse(409, CONFIRM_REFUSED[result.reason]);
      }
    }
    const earned = await earn(c.env, snapshot.bill, membersOf(snapshot));
    if (snapshot.bill.kind === "log") return finishLog(c, grant, earned);
    for (const log of result.removedLogs) c.executionCtx.waitUntil(removeLogPost(log, c.env));
    announce(c, snapshot.bill, withStamps(reconfirmNotice(snapshot.bill, snapshot.participants, result.changes), snapshot.participants, earned));
    return currentState(c, grant);
  }),
);

// The payer reopens to fix their own bill. Anyone else on it reopens it to
// say something is wrong: one person's objection is enough, because a bill
// somebody knows is wrong must not take payments.
api.post(
  "/:billId/reopen",
  splitRoute(async (c, grant) => {
    const snapshot = await loadLive(c, grant);
    if (snapshot instanceof Response) return snapshot;
    const { bill, participants } = snapshot;
    if (grant.participantId !== bill.payerId && !participants.some((p) => p.id === grant.participantId && p.kind === "member")) {
      return refuse(403, "You're not on this bill, so there's nothing here for you to change.");
    }
    const already = "This bill is already back to a draft, so paying is paused.";
    if (bill.status !== "confirmed") return refuse(409, already);

    let changes: AmountChange[];
    try {
      changes = await reopenBill(c.env.DB, grant.billId);
    } catch (error) {
      if (error instanceof BillNotConfirmedError) return refuse(409, already);
      throw error;
    }
    refreshMessage(c, bill);
    announce(c, bill, reopenNotice(bill, participants, changes, grant.participantId));
    return currentState(c, grant);
  }),
);

// What someone has left to pay, after their guests' direct payments and
// their own.
async function leftFor(env: Env, billId: string, debtor: ParticipantId): Promise<Cents> {
  const row = (await outstanding(env.DB, billId)).find((o) => o.participant === debtor);
  return row ? row.owedCents - row.settledCents : 0;
}

function paymentRefused(error: SettlementRefusedError, snapshot: BillSnapshot): Response {
  const left = formatCents(error.remainingCents ?? 0);
  switch (error.reason) {
    case "not-confirmed":
      return refuse(409, `This bill was reopened, so paying is paused until ${payerName(snapshot)} confirms it again.`);
    case "payer":
      return refuse(403, "You paid the bill, so there's nothing for you to pay.");
    case "not-allowed":
      return refuse(403, "You can only record your own payment.");
    case "no-share":
      return refuse(409, "You have no share on this bill, so there's nothing for you to pay.");
    case "not-positive":
      return refuse(400, "That amount is $0.00, so there's nothing to record.");
    case "clear":
      return refuse(409, "You're all paid up on this bill.");
    case "stale":
      return refuse(409, `What you owe changed. You have ${left} left to pay.`);
    case "over":
      return refuse(400, `That's more than you have left to pay, which is ${left}.`);
  }
}

// The person paid, all of it: someone has paid or they haven't. `amount` is
// what the page showed as left, and it must still be what is left, so a
// part payment is refused and so is a payment against an amount they never
// saw. `id` comes from the page, one per tap, so a retried request finds its
// own payment. A tap from someone already paid up changes nothing.
api.post(
  "/:billId/payment",
  splitRoute(async (c, grant) => {
    const body = await readBody(c);
    expectKeys(body, ["id", "amount"]);
    const id = text(body.id, "id");
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) bad('"id" must be 8 to 64 letters, digits or dashes.');
    const amount = cents(body.amount, "amount", { signed: false });

    const snapshot = await loadLive(c, grant);
    if (snapshot instanceof Response) return snapshot;
    const { bill, participants } = snapshot;
    if (grant.participantId === bill.payerId) return refuse(403, "You paid the bill, so there's nothing for you to pay.");

    let recorded: boolean;
    try {
      recorded = await recordSettlement(c.env.DB, grant.billId, grant.participantId, amount, grant.participantId, {
        id: `${grant.participantId}:${id}`,
        remainingCents: amount,
      });
    } catch (error) {
      if (error instanceof SettlementRefusedError && error.reason === "clear") return currentState(c, grant);
      if (error instanceof SettlementRefusedError) return paymentRefused(error, snapshot);
      throw error;
    }
    if (recorded) {
      refreshMessage(c, bill);
      const after = await leftFor(c.env, grant.billId, grant.participantId);
      const earned = await earn(c.env, bill, [grant.participantId]);
      announce(c, bill, withStamps(paymentNotice(bill, participants, grant.participantId, amount, after), participants, earned));
    }
    return currentState(c, grant);
  }),
);

function markRefused(error: SettlementRefusedError, snapshot: BillSnapshot, who: ParticipantId): Response {
  const name = snapshot.participants.find((p) => p.id === who)?.displayName ?? "They";
  switch (error.reason) {
    case "not-confirmed":
      return refuse(409, "This bill was reopened, so payments are paused until you confirm it again.");
    case "stale":
    case "over":
      return refuse(409, `What ${name} owes changed. They have ${formatCents(error.remainingCents ?? 0)} left to pay.`);
    case "not-positive":
      return refuse(400, "That amount is $0.00, so there's nothing to record.");
    default:
      return refuse(409, `${name} has nothing to pay on this bill.`);
  }
}

// The payer's word that someone paid them, cash at the table say. It is the
// same payment "I paid" makes, recorded by the payer, so everything derived
// from payments comes out the same. A guest the payer added isn't a member, so
// the page sends them through the guest's own mark instead.
api.post(
  "/:billId/paid/:participantId",
  splitRoute(async (c, grant) => {
    const body = await readBody(c);
    expectKeys(body, ["id", "amount"]);
    const id = text(body.id, "id");
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) bad('"id" must be 8 to 64 letters, digits or dashes.');
    const amount = cents(body.amount, "amount", { signed: false });

    const snapshot = await loadLive(c, grant);
    if (snapshot instanceof Response) return snapshot;
    const { bill, participants } = snapshot;
    if (grant.participantId !== bill.payerId) {
      return refuse(403, `Only ${payerName(snapshot)} can mark someone paid, because it was paid to them.`);
    }
    const who = c.req.param("participantId") ?? "";

    let recorded: boolean;
    try {
      recorded = await recordSettlement(c.env.DB, grant.billId, who, amount, grant.participantId, {
        id: `${grant.participantId}:${id}`,
        remainingCents: amount,
      });
    } catch (error) {
      if (error instanceof SettlementRefusedError && error.reason === "clear") return currentState(c, grant);
      if (error instanceof SettlementRefusedError) return markRefused(error, snapshot, who);
      throw error;
    }
    if (recorded) {
      refreshMessage(c, bill);
      const earned = await earn(c.env, bill, []);
      announce(c, bill, withStamps(markedPaidNotice(bill, participants, who, amount, await leftFor(c.env, grant.billId, who)), participants, earned));
    }
    return currentState(c, grant);
  }),
);

const PAYMENT_GONE = "That payment isn't on this bill any more.";

// Only the payer takes a payment back: it was paid to them, so they are the
// one who knows it never arrived. It takes back the person's paid, whole.
api.delete(
  "/:billId/paid/:participantId",
  splitRoute(async (c, grant) => {
    const snapshot = await loadLive(c, grant);
    if (snapshot instanceof Response) return snapshot;
    const { bill, participants } = snapshot;
    if (grant.participantId !== bill.payerId) {
      return refuse(403, `Only ${payerName(snapshot)} can undo a payment, because it was paid to them.`);
    }
    const who = c.req.param("participantId") ?? "";

    let taken: Cents;
    try {
      taken = await undoPaid(c.env.DB, grant.billId, who);
    } catch (error) {
      if (error instanceof SettlementGoneError) return refuse(404, PAYMENT_GONE);
      // A reopened bill's payments are what its re-confirm reports against.
      if (error instanceof BillNotConfirmedError) {
        return refuse(409, "This bill was reopened, so its payments stay as they are until it's confirmed again.");
      }
      throw error;
    }
    refreshMessage(c, bill);
    const paidBy = participants.find((p) => p.id === who);
    const after = await leftFor(c.env, grant.billId, paidBy ? debtorOf(paidBy, bill.payerId) : who);
    announce(c, bill, undoNotice(bill, participants, who, taken, after));
    return currentState(c, grant);
  }),
);

// `paid` is the payment total the page showed the payer when they agreed to
// throw it away; a payment recorded since means they agreed to something else.
api.delete(
  "/:billId",
  route(async (c, grant) => {
    const body = await readBody(c);
    expectKeys(body, ["paid"]);
    const paid = cents(body.paid, "payments total", { signed: false });

    const snapshot = await loadLive(c, grant);
    if (snapshot instanceof Response) return snapshot;
    if (grant.participantId !== snapshot.bill.payerId) {
      return refuse(403, `Only ${payerName(snapshot)} can delete the bill, because they paid.`);
    }
    if (snapshot.bill.kind === "log") return reply(await removeLog(c.env, snapshot.bill));
    try {
      await deleteBill(c.env.DB, grant.billId, paid);
    } catch (error) {
      if (error instanceof PaymentsChangedError) {
        return refuse(409, "Someone paid since you looked, so nothing was deleted. Look again before you delete it.");
      }
      if (error instanceof BillGoneError) return refuse(409, GONE.deleted!);
      throw error;
    }
    refreshMessage(c, snapshot.bill);
    return reply({ deleted: true });
  }),
);
