import type { ReadPermit } from "./read-limit";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
// Haiku reads receipts well but let three of five forgeries through when asked
// these same questions. Sonnet caught all five and flagged none of twenty real
// receipts, so this one call costs more than the read does.
const MODEL = "claude-sonnet-5-5";
const MAX_TOKENS = 2000;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    medium: {
      type: "string",
      enum: ["photo_of_paper", "digital_receipt", "imitation_of_paper"],
      description:
        "photo_of_paper: a camera photo or scan of a physical printed slip. digital_receipt: a screenshot of, saved copy of, or photo of a screen showing an order in an app, on a website or in an email, with that app's or sender's own layout. imitation_of_paper: made on a computer to look like a paper slip or a photo of one.",
    },
    edited: {
      type: "boolean",
      description:
        "true if a price, total, date or time looks changed after printing: its digits differ from the neighbouring text in font, weight, size, sharpness, brightness or spacing, or the paper behind them is a different shade.",
    },
    till_printed: {
      type: "boolean",
      description:
        "Only matters for paper. true if the type looks printed by a real receipt printer: thermal dots or ink, uneven fading, a till's own layout. false if it looks like a word processor or receipt generator font.",
    },
  },
  required: ["medium", "edited", "till_printed"],
  additionalProperties: false,
} as const;

const PROMPT =
  "People send photos of restaurant receipts, or screenshots of e-receipts, to claim credit for a meal, and some forge them. Examine the image(s) as a document examiner would, then give your verdict. Most are genuine: faded, creased, crooked and old receipts are normal and are not evidence, and neither is a screenshot of an order or an emailed receipt. Look at the type itself, and look hardest at the total, the prices and the date and time.";

// Three separate questions, because asked once for "is this fake" the model
// says no to nearly everything.
function isFlagged(text: string): boolean {
  let verdict: { medium?: unknown; edited?: unknown; till_printed?: unknown };
  try {
    verdict = JSON.parse(text);
  } catch {
    return false;
  }
  return verdict.medium === "imitation_of_paper" || verdict.edited === true || (verdict.medium === "photo_of_paper" && verdict.till_printed === false);
}

// A failed check is not flagged: the worst it does is let one receipt through
// unchecked, where flagging would put an honest person on blast over an outage.
// It spends the read its permit already counted and never retries, so a /log
// uses one read like a /split does, though it costs more.
export async function looksFake(permit: ReadPermit, apiKey: string, options: { signal?: AbortSignal } = {}): Promise<boolean> {
  try {
    const response = await fetch(MESSAGES_URL, {
      method: "POST",
      signal: options.signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA } },
        messages: [
          {
            role: "user",
            content: [...permit.imageUrls.map((url) => ({ type: "image", source: { type: "url", url } })), { type: "text", text: PROMPT }],
          },
        ],
      }),
    });
    if (!response.ok) return false;
    const body: { content?: { type?: string; text?: string }[]; usage?: unknown } = await response.json();
    console.log("fake check usage", JSON.stringify(body.usage));
    const text = body.content?.find((block) => block.type === "text")?.text;
    return typeof text === "string" && isFlagged(text);
  } catch {
    return false;
  }
}
