import type { Cents } from "../money/types";

export interface Extraction {
  place: string | null;
  billDate: string | null;
  items: { label: string; cents: Cents; confidence: number }[];
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
      items: {
        type: "array",
        description: "Every charged line, in printed order. Discounts, comps and service charges are lines too, with a negative price for money taken off.",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            price: { ...PRICE, description: "Total price of the line (quantity already applied), as printed." },
            confidence: { type: "number", minimum: 0, maximum: 1, description: "How sure you are that label and price were read correctly." },
          },
          required: ["label", "price", "confidence"],
        },
      },
      tax: NULLABLE_PRICE,
      printed_total: { ...NULLABLE_PRICE, description: "The grand total printed on the receipt before any tip is added. " + NULLABLE_PRICE.description },
    },
    required: ["is_receipt", "readable", "place", "bill_date", "items", "tax", "printed_total"],
  },
} as const;

export const EXTRACT_PROMPT = [
  "Read the attached receipt photo(s) and record them with the record_receipt tool. Multiple photos are parts of the same receipt.",
  "Copy every price exactly as printed. Do not round, correct, or infer an amount.",
  "Items are charged lines only. Include discounts, comps and service charges as signed items (negative when money comes off).",
  "Leave subtotal, tax, total, tip and payment lines out of items.",
  "Report the printed tax and the printed total before any tip, or null if absent or illegible.",
  "Give each item a confidence from 0 to 1 for how sure you are of its label and price.",
  "If the image is not a receipt set is_receipt to false. If it is one but you cannot read the amounts set readable to false.",
].join("\n");

export type ParsedToolInput =
  | { kind: "extraction"; extraction: Extraction }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseToolInput(input: unknown): ParsedToolInput {
  if (!isRecord(input)) return { kind: "invalid" };
  if (typeof input.is_receipt !== "boolean" || typeof input.readable !== "boolean") return { kind: "invalid" };
  if (!input.is_receipt) return { kind: "not-a-receipt" };
  if (!input.readable) return { kind: "unreadable" };

  const place = parseNullableString(input.place);
  const billDate = parseNullableString(input.bill_date);
  const taxCents = parseNullablePrice(input.tax);
  const printedTotalCents = parseNullablePrice(input.printed_total);
  if (place === undefined || billDate === undefined || taxCents === undefined || printedTotalCents === undefined) {
    return { kind: "invalid" };
  }
  if (!Array.isArray(input.items)) return { kind: "invalid" };

  const items: Extraction["items"] = [];
  for (const raw of input.items) {
    if (!isRecord(raw) || typeof raw.label !== "string") return { kind: "invalid" };
    const cents = parsePriceCents(raw.price);
    const confidence = raw.confidence;
    if (cents === null) return { kind: "invalid" };
    if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) return { kind: "invalid" };
    items.push({ label: raw.label, cents, confidence });
  }

  if (items.length === 0) return { kind: "not-a-receipt" };
  return { kind: "extraction", extraction: { place, billDate, items, taxCents, printedTotalCents } };
}
