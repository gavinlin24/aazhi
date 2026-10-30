export type Cents = number;
export type ParticipantId = string;

export interface LineItem {
  id: string;
  label: string;
  note?: string;                // modifiers printed under the dish, display only
  cents: Cents;                 // negative for a discount or comp
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
