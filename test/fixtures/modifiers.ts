// Tool inputs the real model returned for three receipts with modifiers, in
// three common till layouts. Recorded so the parser and the reconciliation
// are pinned to what the model actually sends, not to what we hope it sends.

// Modifiers indented under the dish, charged ones in the dish's price column.
export const PATTY_SHACK = {
  is_receipt: true,
  readable: true,
  place: "Patty Shack",
  bill_date: "2026-10-24",
  items: [
    {
      label: "Classic Burger",
      price: "14.00",
      modifiers: [
        { label: "Medium Rare", price: "0.00" },
        { label: "Extra Patty", price: "3.00" },
        { label: "Add Bacon", price: "2.50" },
        { label: "No Onions", price: null },
      ],
      confidence: 0.95,
    },
    {
      label: "Veggie Burger",
      price: "13.00",
      modifiers: [
        { label: "Gluten Free Bun", price: "2.00" },
        { label: "No Pickles", price: null },
      ],
      confidence: 0.95,
    },
    { label: "Fries", price: "5.00", modifiers: [{ label: "Truffle Oil", price: "1.50" }], confidence: 0.95 },
    { label: "Soda", price: "6.00", modifiers: [], confidence: 0.95 },
  ],
  tax: "4.17",
  printed_total: "51.17",
};

// "+" adds a charged extra, "-" takes something off for free.
export const LA_PALMA = {
  is_receipt: true,
  readable: true,
  place: "La Palma Taqueria",
  bill_date: "2026-10-25",
  items: [
    {
      label: "Burrito Bowl",
      price: "12.50",
      modifiers: [
        { label: "Guacamole", price: "2.25" },
        { label: "Extra Chicken", price: "3.50" },
        { label: "No rice", price: null },
      ],
      confidence: 0.97,
    },
    { label: "Tacos (3)", price: "10.50", modifiers: [{ label: "Cheese", price: "1.00" }], confidence: 0.97 },
    { label: "Horchata", price: "4.00", modifiers: [], confidence: 0.98 },
    { label: "Chips & Salsa", price: "4.50", modifiers: [], confidence: 0.98 },
  ],
  tax: "3.25",
  printed_total: "41.50",
};

// The dish price already includes its modifiers, whose amounts print beside
// their names in brackets. The model still charged "Add Corn ($1.00)" on top
// in every recorded run, so this read is $1.00 over until the modifiers are
// taken as included.
export const MENSHO = {
  is_receipt: true,
  readable: true,
  place: "Mensho Ramen Bar",
  bill_date: "2026-10-26",
  items: [
    {
      label: "Tonkotsu Ramen",
      price: "19.00",
      modifiers: [
        { label: "Extra Chashu", price: null },
        { label: "Soft Egg", price: null },
        { label: "Spicy", price: null },
      ],
      confidence: 0.9,
    },
    { label: "Gyoza", price: "8.00", modifiers: [], confidence: 0.95 },
    { label: "Shoyu Ramen", price: "16.00", modifiers: [{ label: "Add Corn", price: "1.00" }], confidence: 0.9 },
    { label: "Sapporo", price: "7.00", modifiers: [], confidence: 0.95 },
  ],
  tax: "4.44",
  printed_total: "54.44",
};
