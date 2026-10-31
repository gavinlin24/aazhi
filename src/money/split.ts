import type { BillInput, Cents, LineItem, ParticipantId, Share, SplitResult } from "./types";

// Every proration is the exact rational a * b / d of integer cents. Working in
// BigInt keeps the product exact beyond 2^53 and makes a fractional input throw
// instead of quietly becoming a float amount.
function divide(a: Cents, b: Cents, d: Cents): { quotient: bigint; remainder: bigint; divisor: bigint } {
  let numerator = BigInt(a) * BigInt(b);
  let divisor = BigInt(d);
  // A positive divisor lets one floor rule serve both signs of numerator, and
  // keeps remainders in [0, divisor) so they compare directly as fractions.
  if (divisor < 0n) {
    numerator = -numerator;
    divisor = -divisor;
  }
  let quotient = numerator / divisor;
  let remainder = numerator % divisor;
  if (remainder < 0n) {
    quotient -= 1n;
    remainder += divisor;
  }
  return { quotient, remainder, divisor };
}

function floorDiv(a: Cents, b: Cents, d: Cents): Cents {
  return Number(divide(a, b, d).quotient);
}

function roundDiv(a: Cents, b: Cents, d: Cents): Cents {
  const { quotient, remainder, divisor } = divide(a, b, d);
  return Number(2n * remainder >= divisor ? quotient + 1n : quotient);
}

// Default sort compares UTF-16 code units, so the order that decides who gets
// a stray cent is the same on every machine and locale.
function byId(ids: Iterable<ParticipantId>): ParticipantId[] {
  return [...new Set(ids)].sort();
}

// Each person gets the floor of their exact share, then the cents still needed
// to reach the target go to the largest fractional parts. Remainders share one
// divisor, so comparing them compares the fractions exactly.
function largestRemainder(
  subtotals: Map<ParticipantId, Cents>,
  distributableCents: Cents,
  billSubtotalCents: Cents,
  targetCents: Cents,
): Map<ParticipantId, Cents> {
  const exact = [...subtotals].map(([p, subtotal]) => ({
    p,
    ...divide(subtotal, distributableCents, billSubtotalCents),
  }));
  const owed = new Map(exact.map(({ p, quotient }) => [p, Number(quotient)]));
  let leftover = exact.reduce((left, { quotient }) => left - Number(quotient), targetCents);

  exact.sort((x, y) => {
    if (x.remainder !== y.remainder) return x.remainder > y.remainder ? -1 : 1;
    return x.p < y.p ? -1 : 1;
  });
  for (const { p } of exact) {
    if (leftover <= 0) break;
    owed.set(p, owed.get(p)! + 1);
    leftover--;
  }
  return owed;
}

// One equal part each, with spare cents going one apiece in id order.
function evenPieces(cents: Cents, people: ParticipantId[]): Map<ParticipantId, Cents> {
  const ids = byId(people);
  if (ids.length === 0) return new Map();
  const base = floorDiv(cents, 1, ids.length);
  const leftover = cents - base * ids.length;
  return new Map(ids.map((p, i) => [p, base + (i < leftover ? 1 : 0)]));
}

// What each claimant's piece of one line is. Exported so anything that shows a
// person their pieces shows the same cents the split itself used.
export function itemPieces(item: LineItem): Map<ParticipantId, Cents> {
  return evenPieces(item.cents, item.claimedBy);
}

// Whether a displayed slice points the way its exact value does: zero when
// there is nothing to share, never the opposite sign of a real amount.
function fits(cents: Cents, exactSign: number): boolean {
  return exactSign === 0 ? cents === 0 : Math.sign(cents) !== -exactSign;
}

export function splitBill(input: BillInput): SplitResult {
  if (input.tipCents < 0) throw new RangeError(`Tip cannot be negative (got ${input.tipCents} cents)`);
  if (input.discountCents < 0) throw new RangeError(`Discount cannot be negative (got ${input.discountCents} cents)`);

  const participants = byId(input.participants);
  const subtotals = new Map<ParticipantId, Cents>(participants.map((p) => [p, 0]));

  let billSubtotalCents = 0;
  let claimedSubtotalCents = 0;
  for (const item of input.items) {
    billSubtotalCents += item.cents;
    if (item.claimedBy.length === 0) continue;
    claimedSubtotalCents += item.cents;

    for (const [p, piece] of itemPieces(item)) {
      const subtotal = subtotals.get(p);
      if (subtotal === undefined) throw new Error(`Item "${item.id}" is claimed by ${p}, who is not on the bill`);
      subtotals.set(p, subtotal + piece);
    }
  }

  // The discount rides each person's subtotal exactly as tax and tip do, so it
  // is one more term of the same proration rather than a step of its own.
  const distributableCents = billSubtotalCents - input.discountCents + input.taxCents + input.tipCents;
  const fullyClaimed = input.items.every((item) => item.claimedBy.length > 0);
  const tipEvenly = input.tipSplit === "even";
  // A person is someone with a line, not a roster row: opening the link adds a
  // row, and looking at the bill shouldn't cost anyone a part of the tip. A
  // bill can't confirm with a line unclaimed, so until then this is a preview
  // that drops as more people claim.
  const tipParts = tipEvenly ? evenPieces(input.tipCents, input.items.flatMap((item) => item.claimedBy)) : new Map<ParticipantId, Cents>();
  const tipPartsCents = [...tipParts.values()].reduce((total, cents) => total + cents, 0);
  // An even tip has no proration, so it stays out of what follows subtotals.
  const proratedCents = tipEvenly ? distributableCents - input.tipCents : distributableCents;
  const isZeroBill = billSubtotalCents === 0;
  // Distribute only the claimed slice of the bill. Rounding toward the full
  // distributable total would hand unclaimed money to whoever claimed first.
  const claimedTargetCents = isZeroBill
    ? 0
    : roundDiv(claimedSubtotalCents, proratedCents, billSubtotalCents);
  const prorated = isZeroBill
    ? new Map(participants.map((p) => [p, 0]))
    : largestRemainder(subtotals, proratedCents, billSubtotalCents, claimedTargetCents);

  const pardoned = new Set(input.pardoned);
  const shares: Share[] = participants.map((p) => {
    const subtotalCents = isZeroBill ? 0 : subtotals.get(p)!;
    const proratedShare = prorated.get(p)!;
    const owedCents = proratedShare + (tipParts.get(p) ?? 0);
    const slice = (cents: Cents) => (isZeroBill ? 0 : roundDiv(cents, subtotalCents, billSubtotalCents));
    const sign = (cents: Cents) => Math.sign(cents) * Math.sign(subtotalCents) * Math.sign(billSubtotalCents);
    // The tip line absorbs the rounding so the displayed lines add up to the
    // total; tip is the payer's own number, not one printed on paper. But a
    // stray cent must not show a -$0.01 tip on a no-tip bill, or any slice
    // pointing the opposite way from the person's real one, so then tax takes
    // it, or the discount on a bill with neither. An even tip is an exact
    // part, so there the same two always take it.
    let discountCents = slice(input.discountCents);
    let taxCents = slice(input.taxCents);
    const stray = proratedShare - subtotalCents + discountCents - taxCents;
    let tipCents = tipEvenly ? (tipParts.get(p) ?? 0) : stray;
    if (tipEvenly || !fits(stray, sign(input.tipCents))) {
      if (!tipEvenly) tipCents = 0;
      if (!fits(taxCents + stray, sign(input.taxCents)) && fits(discountCents - stray, sign(input.discountCents))) {
        discountCents -= stray;
      } else {
        taxCents += stray;
      }
    }
    return {
      participant: p,
      subtotalCents,
      discountCents,
      taxCents,
      tipCents,
      owedCents,
      pardoned: pardoned.has(p),
    };
  });

  // Pardons never redistribute: the payer simply stops collecting that share.
  const payerCollectsCents = shares.reduce(
    (total, s) => (s.participant === input.payer || s.pardoned ? total : total + s.owedCents),
    0,
  );

  return {
    billSubtotalCents,
    distributableCents,
    claimedSubtotalCents,
    unclaimedCents: distributableCents - claimedTargetCents - tipPartsCents,
    shares,
    payerCollectsCents,
    fullyClaimed,
  };
}
