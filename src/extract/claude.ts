import type { Cents } from "../money/types";
import {
  EXTRACT_PROMPT,
  EXTRACT_TOOL,
  EXTRACT_TOOL_NAME,
  parseToolInput,
  type Extraction,
  type ExtractionResult,
} from "./schema";

export type { Extraction, ExtractionResult } from "./schema";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-5-5";
// 13 items is about 600 tokens of JSON; this leaves room for a long bill
// without letting a runaway response bill us for much.
const MAX_TOKENS = 4096;

// Takes only the amounts so a stored bill is checked by the same rule as a
// fresh read.
export function reconciles(
  e: Pick<Extraction, "taxCents" | "printedTotalCents"> & { items: { cents: Cents }[] },
): { ok: boolean; discrepancyCents: Cents | null } {
  if (e.printedTotalCents === null) return { ok: false, discrepancyCents: null };
  const sum = e.items.reduce((total, item) => total + item.cents, 0) + (e.taxCents ?? 0);
  const discrepancy = sum - e.printedTotalCents;
  return discrepancy === 0 ? { ok: true, discrepancyCents: null } : { ok: false, discrepancyCents: discrepancy };
}

type Attempt =
  | { kind: "tool-input"; input: unknown }
  | { kind: "malformed" }
  | { kind: "api-error" };

async function callModel(
  imageUrls: string[],
  apiKey: string,
  onUsage: (usage: unknown) => void,
  signal: AbortSignal | undefined,
): Promise<Attempt> {
  let response: Response;
  try {
    response = await fetch(MESSAGES_URL, {
      method: "POST",
      signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: "tool", name: EXTRACT_TOOL_NAME },
        messages: [
          {
            role: "user",
            content: [
              // A URL source keeps multi-MB photos out of the Worker's CPU budget.
              ...imageUrls.map((url) => ({ type: "image", source: { type: "url", url } })),
              { type: "text", text: EXTRACT_PROMPT },
            ],
          },
        ],
      }),
    });
  } catch {
    return { kind: "api-error" };
  }
  // A 4xx (empty credit balance, bad key) will not heal on a second try, and
  // a 5xx is not worth burning the Worker's subrequest budget on.
  if (!response.ok) return { kind: "api-error" };

  let body: { content?: unknown; usage?: unknown };
  try {
    body = await response.json();
  } catch {
    return { kind: "malformed" };
  }
  onUsage(body.usage);

  const blocks = Array.isArray(body.content) ? body.content : [];
  const toolUse = blocks.find(
    (block): block is { input: unknown } =>
      typeof block === "object" && block !== null && block.type === "tool_use" && block.name === EXTRACT_TOOL_NAME,
  );
  return toolUse ? { kind: "tool-input", input: toolUse.input } : { kind: "malformed" };
}

// `signal` is the caller's deadline. An aborted call surfaces as a model error
// ("try again shortly") rather than hanging until the runtime kills the work.
export async function extractReceipt(
  imageUrls: string[],
  apiKey: string,
  options: { signal?: AbortSignal } = {},
): Promise<ExtractionResult> {
  let usageLogged = false;
  // The plan's cost estimate assumes a photo hits the 4,784 visual-token cap;
  // this line is how we find out whether that is true.
  const logFirstUsage = (usage: unknown) => {
    if (usageLogged) return;
    usageLogged = true;
    console.log("extract usage", JSON.stringify(usage));
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    // A retry past the deadline would only be aborted; an answer that already
    // arrived is still used.
    if (attempt > 0 && options.signal?.aborted) break;
    const result = await callModel(imageUrls, apiKey, logFirstUsage, options.signal);
    if (result.kind === "api-error") return { ok: false, reason: "model-error" };
    if (result.kind === "malformed") continue;

    const parsed = parseToolInput(result.input);
    if (parsed.kind === "invalid") continue;
    if (parsed.kind !== "extraction") return { ok: false, reason: parsed.kind };

    const check = reconciles(parsed.extraction);
    return { ok: true, extraction: parsed.extraction, reconciles: check.ok, discrepancyCents: check.discrepancyCents };
  }
  return { ok: false, reason: "model-error" };
}
