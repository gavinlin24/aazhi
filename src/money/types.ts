export type Cents = number;
export type ParticipantId = string;

// Something ordered with a dish, like an extra patty. Unpriced ones ("No
// onions") are 0.
export interface Addon {
  label: string;
  cents: Cents;
}

export interface LineItem {
  id: string;
  label: string;
  addons?: Addon[];
  cents: Cents;                 // the dish with its add-ons; negative for a discount or comp
  claimedBy: ParticipantId[];
}

export type TipSplit = "items" | "even";

export interface BillInput {
  items: LineItem[];
  // Money off the whole bill, like a promo printed under the subtotal. Positive.
  discountCents: Cents;
  taxCents: Cents;
  tipCents: Cents;
  // Left out means "items", the way every bill worked before the choice.
  tipSplit?: TipSplit;
  payer: ParticipantId;
  participants: ParticipantId[];
  pardoned: ParticipantId[];
}

export interface Share {
  participant: ParticipantId;
  subtotalCents: Cents;         // what this person ordered
  discountCents: Cents;         // displayed slice of the bill discount, positive
  taxCents: Cents;              // displayed tax slice
  tipCents: Cents;              // displayed tip slice; absorbs the stray cent when split by items
  owedCents: Cents;             // === subtotalCents - discountCents + taxCents + tipCents
  pardoned: boolean;
}

export interface SplitResult {
  billSubtotalCents: Cents;
  distributableCents: Cents;    // billSubtotal - discount + tax + tip
  claimedSubtotalCents: Cents;
  unclaimedCents: Cents;        // distributable share of unclaimed lines
  shares: Share[];
  payerCollectsCents: Cents;
  fullyClaimed: boolean;
}
