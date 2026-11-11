// Receipts that are not from a restaurant or cafe. The first two are the reads
// of two receipts that were logged and confirmed in production before aazhi
// asked what kind of place a receipt came from, with the place_kind the model
// is now asked for. Each one is otherwise a clean, reconciling read, so only
// the kind of place can refuse it.

export const PHARMACY_WIPES = {
  is_receipt: true,
  readable: true,
  place_kind: "pharmacy",
  place: "CVS Pharmacy",
  bill_date: "2026-11-04",
  printed_time: "6:01 PM",
  items: [{ label: "1 TH FLSHBL WPES 42CT", price: "3.19", modifiers: [], confidence: 0.85 }],
  discount: null,
  tax: "0.33",
  printed_total: "3.52",
};

export const SUPERSTORE_SINUS_RINSE = {
  is_receipt: true,
  readable: true,
  place_kind: "other_store",
  place: "Target - Los Angeles USC Village",
  bill_date: "2026-11-05",
  printed_time: "9:22 PM",
  items: [{ label: "HEALTH AND BEAUTY 094030677 NEILMED", price: "14.99", modifiers: [], confidence: 0.9 }],
  discount: null,
  tax: "1.54",
  printed_total: "16.53",
};

export const BAR_TAB = {
  is_receipt: true,
  readable: true,
  place_kind: "bar",
  place: "Lucky Seven Tavern",
  bill_date: "2026-11-05",
  printed_time: "11:48 PM",
  items: [
    { label: "2 Fort Point Pale Ale", price: "18.00", modifiers: [], confidence: 0.95 },
    { label: "1 Old Fashioned", price: "15.00", modifiers: [], confidence: 0.95 },
  ],
  discount: null,
  tax: "3.14",
  printed_total: "36.14",
};
