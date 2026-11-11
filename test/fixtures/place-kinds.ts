// Clean, reconciling reads that differ in the kind of place, so only that can
// refuse them. The first two are the reads of two receipts that were logged and
// confirmed in production before aazhi asked what kind of place a receipt came
// from, with the place_kind the model is now asked for.

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

export const BOBA_SHOP = {
  is_receipt: true,
  readable: true,
  place_kind: "boba_or_tea_shop",
  place: "TP TEA - Diamond Bar",
  bill_date: "2026-10-30",
  printed_time: "7:20 PM",
  items: [{ label: "1x Yuzu Emerald Fruit Tea", price: "6.50", modifiers: [], confidence: 0.95 }],
  discount: null,
  tax: "0.45",
  printed_total: "6.95",
};

export const BAKERY = {
  is_receipt: true,
  readable: true,
  place_kind: "bakery",
  place: "Golden Crust Bakery",
  bill_date: "2026-10-30",
  printed_time: "8:05 AM",
  items: [
    { label: "Almond Croissant", price: "4.75", modifiers: [], confidence: 0.95 },
    { label: "Pain au Chocolat", price: "4.25", modifiers: [], confidence: 0.95 },
  ],
  discount: null,
  tax: "0.00",
  printed_total: "9.00",
};

// Like a dessert split confirmed in production before this check existed.
export const DESSERT_SHOP = {
  is_receipt: true,
  readable: true,
  place_kind: "dessert_shop",
  place: "MAKKEE RH",
  bill_date: "2026-10-30",
  printed_time: "9:51 PM",
  items: [{ label: "Mango Snow Black Sticky Rice", price: "12.99", modifiers: [], confidence: 0.95 }],
  discount: null,
  tax: "0.00",
  printed_total: "12.99",
};

export const JUICE_BAR = {
  is_receipt: true,
  readable: true,
  place_kind: "juice_or_smoothie_shop",
  place: "Green Press Juicery",
  bill_date: "2026-10-30",
  printed_time: "11:15 AM",
  items: [
    { label: "Acai Bowl", price: "12.50", modifiers: [], confidence: 0.95 },
    { label: "Green Machine Smoothie 24oz", price: "9.25", modifiers: [], confidence: 0.95 },
  ],
  discount: null,
  tax: "0.00",
  printed_total: "21.75",
};

export const FOOD_TRUCK = {
  is_receipt: true,
  readable: true,
  place_kind: "food_truck",
  place: "El Sol Taco Truck",
  bill_date: "2026-10-30",
  printed_time: "7:40 PM",
  items: [
    { label: "4 Al Pastor Tacos", price: "10.00", modifiers: [], confidence: 0.95 },
    { label: "Horchata L", price: "4.00", modifiers: [], confidence: 0.95 },
  ],
  discount: null,
  tax: "1.33",
  printed_total: "15.33",
};
