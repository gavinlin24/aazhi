import type { Addon, Cents } from "../money/types";

export interface Extraction {
  place: string | null;
  billDate: string | null;
  // 24-hour HH:MM. Only ever used to tell one receipt from another.
  billTime: string | null;
  // `cents` is the dish with its add-ons, so whoever claims it pays for both.
  items: { label: string; cents: Cents; confidence: number; addons?: Addon[] }[];
  // Money off the whole bill, kept out of items because nobody claims it.
  // Positive, and 0 when there is none.
  discountCents: Cents;
  taxCents: Cents | null;
  printedTotalCents: Cents | null;
}

export type ExtractionResult =
  | { ok: true; extraction: Extraction; reconciles: boolean; discrepancyCents: Cents | null }
  | { ok: false; reason: "unreadable" | "not-a-receipt" | "model-error" };

export const EXTRACT_TOOL_NAME = "record_receipt";

// Prices are decimal strings because a JSON number would reach us as a float,
// and "19.50" has to become 1950 by string parsing, never by multiplication.
const PRICE = { type: "string", description: 'Decimal amount exactly as printed, no currency symbol or thousands separator, e.g. "19.50" or "-8.00".' };
const NULLABLE_PRICE = { type: ["string", "null"], description: PRICE.description + " null if it is not printed or not legible." };

export const EXTRACT_TOOL = {
  name: EXTRACT_TOOL_NAME,
  description: "Record what is printed on the receipt photo(s).",
  input_schema: {
    type: "object",
    properties: {
      is_receipt: { type: "boolean", description: "false if the image is not a receipt or bill at all." },
      readable: { type: "boolean", description: "false if it is a receipt but too blurry, cropped, or dark to read the amounts." },
      place: { type: ["string", "null"], description: "Restaurant name, or null." },
      bill_date: { type: ["string", "null"], description: "Date on the receipt as YYYY-MM-DD, or null." },
      bill_time: {
        type: ["string", "null"],
        description: "Time printed on the receipt as 24-hour HH:MM, or null. If several are printed, use the latest.",
      },
      items: {
        type: "array",
        description:
          "Every charged line, in printed order. Service charges are lines too, and so is a discount or comp printed directly under one item, with a negative price. Whole-bill discounts go in discount, not here.",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            price: { ...PRICE, description: "Price printed on the item's own line (quantity already applied), not counting its modifiers." },
            modifiers: {
              type: "array",
              description: "Modifiers, add-ons and special requests printed under this item, in printed order. Empty if none.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: 'Short phrase, e.g. "Extra patty" or "No onions".' },
                  price: {
                    ...NULLABLE_PRICE,
                    description:
                      "The modifier's own charge in the price column. null if it has no price, or if its amount is shown only as information because the item's price already includes it.",
                  },
                },
                required: ["label", "price"],
              },
            },
            confidence: { type: "number", minimum: 0, maximum: 1, description: "How sure you are that label, price and modifiers were read correctly." },
          },
          required: ["label", "price", "modifiers", "confidence"],
        },
      },
      discount: {
        ...NULLABLE_PRICE,
        description:
          "Total of every discount, comp, promo or coupon printed for the whole bill rather than under one item, as printed, e.g. \"-8.00\". " +
          NULLABLE_PRICE.description,
      },
      tax: NULLABLE_PRICE,
      printed_total: { ...NULLABLE_PRICE, description: "The grand total printed on the receipt before any tip is added. " + NULLABLE_PRICE.description },
    },
    required: ["is_receipt", "readable", "place", "bill_date", "bill_time", "items", "discount", "tax", "printed_total"],
  },
} as const;

export const EXTRACT_PROMPT = [
  "Read the attached receipt photo(s) and record them with the record_receipt tool. Multiple photos are parts of the same receipt.",
  "Copy every price exactly as printed. Do not round, correct, or infer an amount.",
  "Items are charged lines only. Include service charges as items.",
  "A discount or comp printed directly under one item belongs to that item: record it as a negative item right after it.",
  "A discount, comp, promo or coupon for the whole bill (for example \"Happy hour 10% off\" or \"Promo -8.00\" near the subtotal) is not an item. Put the total of all of them in discount.",
  "Leave subtotal, tax, total, tip and payment lines out of items.",
  "A modifier, add-on or special request printed under an item (indented, or marked with +, -, ADD, NO or SUB) belongs to that item. Put it in the item's modifiers, never in items.",
  "Give a modifier a price only when it has its own charge in the price column. Use null when it has no price, or when its amount is printed beside its name (for example \"Soft egg ($2.00)\") rather than in the price column, because the item's price already includes it.",
  "Drop a leading + from a modifier, and write one marked only with - as No (\"- Rice\" becomes \"No rice\").",
  "Report the printed tax and the printed total before any tip, or null if absent or illegible.",
  "Give each item a confidence from 0 to 1 for how sure you are of its label and price.",
  "If the image is not a receipt set is_receipt to false. If it is one but you cannot read the amounts set readable to false.",
].join("\n");

// `modifiersIncluded` is the same read with every priced modifier taken as
// already inside its item's price. Some tills print a modifier's amount for
// information under a price that includes it, and only the printed total can
// tell that layout from one where the modifier is charged on top. It is there
// only when some modifier has a price.
export type ParsedToolInput =
  | { kind: "extraction"; extraction: Extraction; modifiersIncluded?: Extraction }
  | { kind: "not-a-receipt" }
  | { kind: "unreadable" }
  | { kind: "invalid" };

const PRICE_PATTERN = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

export function parsePriceCents(text: unknown): Cents | null {
  if (typeof text !== "string") return null;
  const match = PRICE_PATTERN.exec(text);
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return sign ? -cents || 0 : cents;
}

function parseNullablePrice(value: unknown): Cents | null | undefined {
  if (value === null) return null;
  const cents = parsePriceCents(value);
  return cents === null ? undefined : cents;
}

function parseNullableString(value: unknown): string | null | undefined {
  if (value === null || typeof value === "string") return value;
  return undefined;
}

// Anything but a clean time is no time. A bill doesn't need one, so a bad read
// here shouldn't fail the whole receipt.
function parseTime(value: unknown): string | null {
  const match = typeof value === "string" ? /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/.exec(value.trim()) : null;
  if (!match || Number(match[1]) > 23) return null;
  return `${match[1]!.padStart(2, "0")}:${match[2]}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Modifier {
  label: string;
  cents: Cents | null;
}

// An unpriced modifier read as "" instead of null is still unpriced. Refusing
// it would fail the whole receipt over a line that carries no money.
function parseModifiers(raw: unknown): Modifier[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const modifiers: Modifier[] = [];
  for (const modifier of raw) {
    if (!isRecord(modifier) || typeof modifier.label !== "string") return null;
    const cents = modifier.price === "" ? null : parseNullablePrice(modifier.price);
    if (cents === undefined) return null;
    modifiers.push({ label: modifier.label.trim(), cents: cents || null });
  }
  return modifiers;
}

// A dish and its modifiers stay one claimable line, so whoever had the burger
// pays for its extra patty. The line is always its base price plus its
// add-ons. Charged on top, the printed price is the base. Already included,
// the printed price is the total and the base is what is left of it.
function line(
  label: string,
  printed: Cents,
  confidence: number,
  modifiers: Modifier[],
  charged: boolean,
): Extraction["items"][number] {
  let addons: Addon[] = modifiers
    .filter((m) => m.label || m.cents !== null)
    .map((m) => ({ label: m.label || "Add-on", cents: m.cents ?? 0 }));
  const extra = addons.reduce((sum, a) => sum + a.cents, 0);
  // Amounts bigger than the dish they are part of are a misread. Kept as
  // names only, the total still matches what the receipt printed.
  if (!charged && printed >= 0 && extra > printed) addons = addons.map((a) => ({ label: a.label, cents: 0 }));
  const cents = charged ? printed + extra : printed;
  return addons.length > 0 ? { label, cents, confidence, addons } : { label, cents, confidence };
}

export function parseToolInput(input: unknown): ParsedToolInput {
  if (!isRecord(input)) return { kind: "invalid" };
  if (typeof input.is_receipt !== "boolean" || typeof input.readable !== "boolean") return { kind: "invalid" };
  if (!input.is_receipt) return { kind: "not-a-receipt" };
  if (!input.readable) return { kind: "unreadable" };

  const place = parseNullableString(input.place);
  const billDate = parseNullableString(input.bill_date);
  const billTime = parseTime(input.bill_time);
  const discount = parseNullablePrice(input.discount ?? null);
  const taxCents = parseNullablePrice(input.tax);
  const printedTotalCents = parseNullablePrice(input.printed_total);
  if (place === undefined || billDate === undefined || discount === undefined || taxCents === undefined || printedTotalCents === undefined) {
    return { kind: "invalid" };
  }
  if (!Array.isArray(input.items)) return { kind: "invalid" };

  const lines: { label: string; printed: Cents; confidence: number; modifiers: Modifier[] }[] = [];
  for (const raw of input.items) {
    if (!isRecord(raw) || typeof raw.label !== "string") return { kind: "invalid" };
    const printed = parsePriceCents(raw.price);
    const confidence = raw.confidence;
    const modifiers = parseModifiers(raw.modifiers);
    if (printed === null || modifiers === null) return { kind: "invalid" };
    if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) return { kind: "invalid" };
    lines.push({ label: raw.label, printed, confidence, modifiers });
  }

  if (lines.length === 0) return { kind: "not-a-receipt" };
  // Receipts print money off either way round, "-8.00" or "8.00" under a
  // Discount label. It is money off whichever sign it came with.
  const discountCents = Math.abs(discount ?? 0);
  const read = (charged: boolean): Extraction => ({
    place,
    billDate,
    billTime,
    items: lines.map((l) => line(l.label, l.printed, l.confidence, l.modifiers, charged)),
    discountCents,
    taxCents,
    printedTotalCents,
  });
  const anyPriced = lines.some((l) => l.modifiers.some((m) => m.cents !== null));
  return { kind: "extraction", extraction: read(true), ...(anyPriced ? { modifiersIncluded: read(false) } : {}) };
}
