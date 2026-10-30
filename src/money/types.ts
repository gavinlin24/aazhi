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

export interface BillInput {
  items: LineItem[];
  taxCents: Cents;
  tipCents: Cents;
  payer: ParticipantId;
  participants: ParticipantId[];
  pardoned: ParticipantId[];
}

export interface Share {
  participant: ParticipantId;
  subtotalCents: Cents;         // what this person ordered
  taxCents: Cents;              // displayed tax slice
  tipCents: Cents;              // displayed tip slice, absorbs the stray cent
  owedCents: Cents;             // === subtotalCents + taxCents + tipCents
  pardoned: boolean;
}

export interface SplitResult {
  billSubtotalCents: Cents;
  distributableCents: Cents;    // billSubtotal + tax + tip
  claimedSubtotalCents: Cents;
  unclaimedCents: Cents;        // distributable share of unclaimed lines
  shares: Share[];
  payerCollectsCents: Cents;
  fullyClaimed: boolean;
}
