import { Hono, type Context } from "hono";
import {
  addItem,
  BillNotDraftError,
  deleteItem,
  editItem,
  getBill,
  getBillSnapshot,
  reassignPayer,
  setBillAmounts,
  setClaim,
  type BillAmounts,
  type BillRow,
  type BillSnapshot,
} from "../db/bills";
import { editBillMessage } from "../discord/rest";
import type { Env } from "../env";
import { parsePriceCents } from "../extract/schema";
import type { Cents, ParticipantId } from "../money/types";
import { stateOf } from "./state";
import { readToken } from "./token";

type Ctx = Context<{ Bindings: Env }>;
type Grant = { billId: string; participantId: ParticipantId };

const LINK_REFUSED =
  "This link has expired or isn't yours. Go back to the bill in Discord and tap Open the split for a fresh one.";
const NOT_FOUND = "This bill doesn't exist any more.";
const NOT_ON_BILL = "You're not on this bill. If you were at dinner, tap Open the split on the bill in Discord to join it.";
const GONE: Partial<Record<BillRow["status"], string>> = {
  superseded: "This split was replaced by a newer one. Open the newer bill message in Discord and tap Open the split there.",
  deleted: "This split was deleted, so there's nothing left to change on it.",
};

// $999,999.99. Far past any dinner, and it keeps every sum of lines well
// inside the range where integer arithmetic stays exact.
const MAX_CENTS = 99_999_999;
const MAX_LABEL = 120;

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

function notDraft(bill: BillRow | null): Response {
  if (!bill) return refuse(409, NOT_FOUND);
  return refuse(
    409,
    GONE[bill.status] ?? "This bill is confirmed, so it can't be changed now. Ask the person who paid to reopen it if something is wrong.",
  );
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

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) bad(`"${field}" must be a non-empty string.`);
  return value;
}

function label(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL) bad(`Give the line a name of 1 to ${MAX_LABEL} characters.`);
  return trimmed;
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
  return snapshot;
}

async function currentState(c: Ctx, grant: Grant): Promise<Response> {
  const snapshot = await getBillSnapshot(c.env.DB, grant.billId);
  if (!snapshot) return refuse(404, NOT_FOUND);
  const gone = GONE[snapshot.bill.status];
  if (gone) return refuse(410, gone);
  return reply(stateOf(snapshot, grant.participantId));
}

// The Discord message is only a summary of the page, so it follows on the
// coalesced timer and a failed edit is logged rather than failing the write.
async function commit(c: Ctx, grant: Grant, bill: BillRow, write: () => Promise<number>): Promise<Response> {
  try {
    await write();
  } catch (error) {
    if (error instanceof BillNotDraftError) return notDraft(await getBill(c.env.DB, grant.billId));
    throw error;
  }
  c.executionCtx.waitUntil(editBillMessage(bill, c.env).catch((error) => console.error("could not update the bill message", error)));
  return currentState(c, grant);
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

export const api = new Hono<{ Bindings: Env }>();

api.get("/:billId/state", route(currentState));

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

    if (!isPayer && participantId !== grant.participantId) {
      return refuse(403, `Only ${payerName(snapshot)} can tap other people onto a line. Tap your own chip for what you had.`);
    }
    if (!onBill(participantId)) {
      return participantId === grant.participantId ? refuse(403, NOT_ON_BILL) : refuse(400, "That person isn't on this bill.");
    }
    if (!snapshot.input.items.some((i) => i.id === itemId)) return refuse(404, "That line isn't on the bill any more.");

    return commit(c, grant, snapshot.bill, () => setClaim(c.env.DB, grant.billId, itemId, participantId, claimed));
  }),
);

api.post(
  "/:billId/item",
  route(async (c, grant) => {
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
        expectKeys(body, ["op", "itemId"], ["label", "price"]);
        if (!("label" in body) && !("price" in body)) bad("Change the line's name, its price, or both.");
        const id = (itemId = text(body.itemId, "itemId"));
        const change = {
          label: "label" in body ? label(body.label) : undefined,
          cents: "price" in body ? cents(body.price, "price", { signed: true }) : undefined,
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
  if (!target) return refuse(400, "That person isn't on this bill. They join it by tapping Open the split in Discord.");
  if (target.kind !== "member") return refuse(400, "A guest can't be the one who paid. Pick someone with a Discord account.");
  return commit(c, grant, snapshot.bill, () => reassignPayer(c.env.DB, grant.billId, to));
}

api.patch(
  "/:billId",
  route(async (c, grant) => {
    const body = await readBody(c);
    expectKeys(body, [], ["tax", "tip", "tipPercent", "printedTotal", "payer"]);
    if (Object.keys(body).length === 0) bad("Nothing to change.");
    if ("payer" in body) return changePayer(c, grant, body);
    if ("tip" in body && "tipPercent" in body) bad("Enter the tip as dollars or as a percentage, not both.");

    const amounts: BillAmounts = {};
    if ("tax" in body) amounts.taxCents = cents(body.tax, "tax", { signed: false });
    if ("tip" in body) amounts.tipCents = cents(body.tip, "tip", { signed: false });
    if ("tipPercent" in body) amounts.tipBasisPoints = basisPoints(body.tipPercent);
    if ("printedTotal" in body) {
      amounts.printedTotalCents = body.printedTotal === null ? null : cents(body.printedTotal, "printed total", { signed: false });
    }

    const snapshot = await loadDraft(c, grant);
    if (snapshot instanceof Response) return snapshot;
    if (grant.participantId !== snapshot.bill.payerId) {
      return refuse(403, `Only ${payerName(snapshot)} can change the tax, tip and total, because they paid.`);
    }
    return commit(c, grant, snapshot.bill, () => setBillAmounts(c.env.DB, grant.billId, amounts));
  }),
);
