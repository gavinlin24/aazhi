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

// What each claimant's piece of one line is. Exported so anything that shows a
// person their pieces shows the same cents the split itself used.
export function itemPieces(item: LineItem): Map<ParticipantId, Cents> {
  const claimants = byId(item.claimedBy);
  if (claimants.length === 0) return new Map();
  const base = floorDiv(item.cents, 1, claimants.length);
  const leftover = item.cents - base * claimants.length;
  return new Map(claimants.map((p, i) => [p, base + (i < leftover ? 1 : 0)]));
}

export function splitBill(input: BillInput): SplitResult {
  if (input.tipCents < 0) throw new RangeError(`Tip cannot be negative (got ${input.tipCents} cents)`);

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

  const distributableCents = billSubtotalCents + input.taxCents + input.tipCents;
  const fullyClaimed = input.items.every((item) => item.claimedBy.length > 0);
  const isZeroBill = billSubtotalCents === 0;
  // Distribute only the claimed slice of the bill. Rounding toward the full
  // distributable total would hand unclaimed money to whoever claimed first.
  const claimedTargetCents = isZeroBill
    ? 0
    : roundDiv(claimedSubtotalCents, distributableCents, billSubtotalCents);
  const owed = isZeroBill
    ? new Map(participants.map((p) => [p, 0]))
    : largestRemainder(subtotals, distributableCents, billSubtotalCents, claimedTargetCents);

  const pardoned = new Set(input.pardoned);
  const shares: Share[] = participants.map((p) => {
    const subtotalCents = isZeroBill ? 0 : subtotals.get(p)!;
    const owedCents = owed.get(p)!;
    const roundedTaxCents = isZeroBill ? 0 : roundDiv(input.taxCents, subtotalCents, billSubtotalCents);
    // The tip line absorbs the rounding so the three displayed lines add up to
    // the total; tip is the payer's own number, not one printed on paper. But a
    // stray cent must not show a -$0.01 tip on a no-tip bill, or any tip pointing
    // the opposite way from the person's real slice, so then tax takes it.
    const absorbingTipCents = owedCents - subtotalCents - roundedTaxCents;
    const exactTipSign = Math.sign(input.tipCents) * Math.sign(subtotalCents) * Math.sign(billSubtotalCents);
    const tipCents = Math.sign(absorbingTipCents) === exactTipSign ? absorbingTipCents : 0;
    return {
      participant: p,
      subtotalCents,
      taxCents: owedCents - subtotalCents - tipCents,
      tipCents,
      owedCents,
      pardoned: pardoned.has(p),
    };
  });

  // Pardons never redistribute: the payer simply stops collecting that share.
  const payerCollectsCents = shares.reduce(
    (total, s) => (s.participant === input.payer || s.pardoned ? total - s.owedCents : total),
    distributableCents,
  );

  return {
    billSubtotalCents,
    distributableCents,
    claimedSubtotalCents,
    unclaimedCents: distributableCents - claimedTargetCents,
    shares,
    payerCollectsCents,
    fullyClaimed,
  };
}
