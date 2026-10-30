import type { Cents } from "../money/types";

export const PAY_METHODS = ["venmo", "cashapp", "zelle"] as const;
export type PayMethod = (typeof PAY_METHODS)[number];

export const METHOD_NAMES: Record<PayMethod, string> = { venmo: "Venmo", cashapp: "Cash App", zelle: "Zelle" };

export const HANDLE_RULES: Record<PayMethod, string> = {
  venmo: "A Venmo username is 5 to 30 letters, numbers, hyphens or underscores, like @gavin-lin.",
  cashapp: "A Cash App $Cashtag is up to 20 letters and numbers with at least one letter, like $GavinL.",
  zelle: "Zelle takes the email address or US mobile number your bank enrolled, like gavin@example.com or (555) 123-4567.",
};

// Each pattern is the app's own rule where it publishes one (Venmo: 5-30
// characters, only - and _ beyond letters and numbers; Cash App: at most 20,
// at least one letter). Nothing outside these sets can reach a link, so a
// handle can never add a path segment, a query parameter or a fragment.
const VENMO = /^[A-Za-z0-9_-]{5,30}$/;
const CASHTAG = /^(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,20}$/;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

// Zelle phone numbers are US numbers, so ten digits once the country code and
// punctuation people type are gone.
function usPhone(raw: string): string | null {
  if (!/^[0-9+().\s-]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{9}$/.test(national) ? national : null;
}

// Returns the handle in the form it is stored and linked, or null when it is
// not a valid handle for that method.
export function normalizeHandle(method: PayMethod, raw: string): string | null {
  const text = raw.trim();
  switch (method) {
    case "venmo": {
      const name = text.startsWith("@") ? text.slice(1) : text;
      return VENMO.test(name) ? name : null;
    }
    case "cashapp": {
      const tag = text.startsWith("$") ? text.slice(1) : text;
      return CASHTAG.test(tag) ? tag : null;
    }
    case "zelle": {
      if (text.includes("@")) {
        const email = text.toLowerCase();
        return email.length <= 254 && EMAIL.test(email) ? email : null;
      }
      return usPhone(text);
    }
  }
}

export function describeHandle(method: PayMethod, handle: string): string {
  switch (method) {
    case "venmo":
      return `@${handle}`;
    case "cashapp":
      return `$${handle}`;
    case "zelle":
      return /^\d{10}$/.test(handle) ? `(${handle.slice(0, 3)}) ${handle.slice(3, 6)}-${handle.slice(6)}` : handle;
  }
}

// "44.46" from 4446 by placing the decimal point in the digit string, so no
// float is ever involved in the amount a friend is asked to send.
function amountString(cents: Cents): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new RangeError(`A payment link needs a positive whole number of cents (got ${cents})`);
  }
  const digits = String(cents).padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

// Discord refuses a whole reply whose link button carries a longer url.
const MAX_LINK_URL = 512;

// The longest whole-character prefix of the note whose encoding fits, marked
// as cut. Characters are counted by code point, because cutting between the
// halves of an emoji leaves a lone surrogate that encodeURIComponent throws on.
function fittedNote(note: string, budget: number): string {
  const encoded = encodeURIComponent(note);
  if (encoded.length <= budget) return encoded;
  const chars = Array.from(note);
  for (let n = chars.length - 1; n > 0; n--) {
    const cut = encodeURIComponent(`${chars.slice(0, n).join("").trimEnd()}…`);
    if (cut.length <= budget) return cut;
  }
  return "";
}

// Venmo: the Payment Links format, venmo.com/<username>?txn=pay&amount=&note=,
// which opens the app with both filled in. Cash App: cash.app/$<cashtag>/<amount>
// prefills the amount, but no form of the link carries a note. Zelle has no
// link at all, since the network is closed to third parties. A pay button is
// only worth having if it lands in the app with the amount filled in, so Zelle
// gets none rather than an address to copy and paste.
export function payLink(method: PayMethod, handle: string, cents: Cents, note: string): { url: string } | null {
  if (normalizeHandle(method, handle) !== handle) throw new Error(`Not a stored ${METHOD_NAMES[method]} handle`);
  const amount = amountString(cents);
  switch (method) {
    case "venmo": {
      const base = `https://venmo.com/${encodeURIComponent(handle)}?txn=pay&amount=${amount}`;
      const fitted = fittedNote(note, MAX_LINK_URL - base.length - "&note=".length);
      return { url: fitted ? `${base}&note=${fitted}` : base };
    }
    case "cashapp":
      return { url: `https://cash.app/$${encodeURIComponent(handle)}/${amount}` };
    case "zelle":
      return null;
  }
}
