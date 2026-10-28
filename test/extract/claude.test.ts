import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractReceipt, reconciles, type Extraction } from "../../src/extract/claude";
import { EXTRACT_TOOL_NAME } from "../../src/extract/schema";
import { SAIGON } from "../fixtures/saigon";

const SAIGON_EXTRACTION: Extraction = {
  place: "Saigon Kitchen",
  billDate: "2026-10-28",
  items: SAIGON.items.map((item) => ({ label: item.label, cents: item.cents, confidence: 0.95 })),
  taxCents: 2232,
  printedTotalCents: 27382,
};

const URL_ONE = "https://cdn.discordapp.com/attachments/1/2/receipt.jpg";

function cents(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const SAIGON_TOOL_INPUT = {
  is_receipt: true,
  readable: true,
  place: "Saigon Kitchen",
  bill_date: "2026-10-28",
  items: SAIGON_EXTRACTION.items.map((item) => ({
    label: item.label,
    price: cents(item.cents),
    confidence: item.confidence,
  })),
  tax: "22.32",
  printed_total: "273.82",
};

const USAGE = { input_tokens: 4784, output_tokens: 612 };

function toolUseResponse(input: unknown): Response {
  return Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_1", name: EXTRACT_TOOL_NAME, input }],
    stop_reason: "tool_use",
    usage: USAGE,
  });
}

function withOverrides(overrides: Record<string, unknown>) {
  return { ...SAIGON_TOOL_INPUT, ...overrides };
}

let fetchMock: ReturnType<typeof vi.fn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reconciles", () => {
  it("reconciles a receipt whose items and tax match the printed total", () => {
    expect(reconciles({ ...SAIGON_EXTRACTION })).toEqual({ ok: true, discrepancyCents: null });
  });

  it("reports the exact discrepancy when a price was misread", () => {
    const misread: Extraction = {
      ...SAIGON_EXTRACTION,
      items: SAIGON_EXTRACTION.items.map((item) =>
        item.label === "Garlic noodles" ? { ...item, cents: 8200 } : item,
      ),
    };
    expect(reconciles(misread)).toEqual({ ok: false, discrepancyCents: 5000 });
  });

  it("reports a negative discrepancy when items were read too low", () => {
    const misread: Extraction = {
      ...SAIGON_EXTRACTION,
      items: SAIGON_EXTRACTION.items.map((item) =>
        item.label === "Garlic noodles" ? { ...item, cents: 200 } : item,
      ),
    };
    expect(reconciles(misread)).toEqual({ ok: false, discrepancyCents: -3000 });
  });

  it("refuses to pass the gate when the printed total is unreadable", () => {
    expect(reconciles({ ...SAIGON_EXTRACTION, printedTotalCents: null })).toEqual({
      ok: false,
      discrepancyCents: null,
    });
  });

  it("counts a missing tax as zero", () => {
    const noTax: Extraction = {
      place: null,
      billDate: null,
      items: [{ label: "Tea", cents: 500, confidence: 1 }],
      taxCents: null,
      printedTotalCents: 500,
    };
    expect(reconciles(noTax)).toEqual({ ok: true, discrepancyCents: null });
  });

  it("closes the arithmetic through a discount line", () => {
    const comped: Extraction = {
      place: null,
      billDate: null,
      items: [
        { label: "Pho", cents: 2100, confidence: 1 },
        { label: "Comp", cents: -800, confidence: 1 },
      ],
      taxCents: 130,
      printedTotalCents: 1430,
    };
    expect(reconciles(comped)).toEqual({ ok: true, discrepancyCents: null });
  });
});

describe("extractReceipt", () => {
  it("returns the extraction with prices converted to integer cents and the gate result", async () => {
    fetchMock.mockResolvedValueOnce(toolUseResponse(SAIGON_TOOL_INPUT));

    const result = await extractReceipt([URL_ONE], "k");

    expect(result).toEqual({
      ok: true,
      extraction: SAIGON_EXTRACTION,
      reconciles: true,
      discrepancyCents: null,
    });
  });

  it("surfaces the discrepancy when the model misreads a line", async () => {
    const items = SAIGON_TOOL_INPUT.items.map((item) =>
      item.label === "Garlic noodles" ? { ...item, price: "82.00" } : item,
    );
    fetchMock.mockResolvedValueOnce(toolUseResponse(withOverrides({ items })));

    const result = await extractReceipt([URL_ONE], "k");

    expect(result).toMatchObject({ ok: true, reconciles: false, discrepancyCents: 5000 });
  });

  it("sends each photo as a URL image block and forces the extraction tool", async () => {
    const second = "https://cdn.discordapp.com/attachments/1/3/receipt-back.jpg";
    fetchMock.mockResolvedValueOnce(toolUseResponse(SAIGON_TOOL_INPUT));

    await extractReceipt([URL_ONE, second], "sk-test");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "x-api-key": "sk-test",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
    const body = JSON.parse(init.body);
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.tool_choice).toEqual({ type: "tool", name: EXTRACT_TOOL_NAME });
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe(EXTRACT_TOOL_NAME);
    const content = body.messages[0].content;
    expect(content.slice(0, 2)).toEqual([
      { type: "image", source: { type: "url", url: URL_ONE } },
      { type: "image", source: { type: "url", url: second } },
    ]);
    expect(content[2].type).toBe("text");
  });

  it.each([
    ["19.50", 1950],
    ["19.5", 1950],
    ["19.05", 1905],
    ["19", 1900],
    ["0.07", 7],
    ["-8.00", -800],
    ["-0.50", -50],
    ["0.00", 0],
    ["-0.00", 0],
  ])("reads the price %s as %i cents", async (price, expected) => {
    const items = [{ label: "Thing", price, confidence: 1 }];
    fetchMock.mockResolvedValueOnce(toolUseResponse(withOverrides({ items, tax: null, printed_total: null })));

    const result = await extractReceipt([URL_ONE], "k");

    expect(result).toMatchObject({ ok: true, extraction: { items: [{ cents: expected }] } });
    if (result.ok) expect(Object.is(result.extraction.items[0].cents, -0)).toBe(false);
  });

  it("keeps a null tax and a null printed total as null and cannot pass the gate", async () => {
    fetchMock.mockResolvedValueOnce(toolUseResponse(withOverrides({ tax: null, printed_total: null })));

    const result = await extractReceipt([URL_ONE], "k");

    expect(result).toMatchObject({
      ok: true,
      extraction: { taxCents: null, printedTotalCents: null },
      reconciles: false,
      discrepancyCents: null,
    });
  });

  it("reports a photo that is not a receipt rather than inventing a bill", async () => {
    fetchMock.mockResolvedValueOnce(toolUseResponse(withOverrides({ items: [], tax: null, printed_total: null })));

    await expect(extractReceipt([URL_ONE], "k")).resolves.toEqual({ ok: false, reason: "not-a-receipt" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("trusts the model when it says the image is not a receipt, without demanding the other fields", async () => {
    fetchMock.mockResolvedValueOnce(toolUseResponse({ is_receipt: false, readable: false }));

    await expect(extractReceipt([URL_ONE], "k")).resolves.toEqual({ ok: false, reason: "not-a-receipt" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a receipt the model cannot read as unreadable", async () => {
    fetchMock.mockResolvedValueOnce(toolUseResponse(withOverrides({ readable: false, items: [] })));

    await expect(extractReceipt([URL_ONE], "k")).resolves.toEqual({ ok: false, reason: "unreadable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once on a schema violation and uses the second answer", async () => {
    fetchMock
      .mockResolvedValueOnce(toolUseResponse(withOverrides({ items: "none" })))
      .mockResolvedValueOnce(toolUseResponse(SAIGON_TOOL_INPUT));

    const result = await extractReceipt([URL_ONE], "k");

    expect(result).toMatchObject({ ok: true, reconciles: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once on a schema violation and then gives up", async () => {
    fetchMock
      .mockResolvedValueOnce(toolUseResponse(withOverrides({ items: "none" })))
      .mockResolvedValueOnce(toolUseResponse(withOverrides({ items: "none" })));

    await expect(extractReceipt([URL_ONE], "k")).resolves.toEqual({ ok: false, reason: "model-error" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a reply with no tool call as a schema violation", async () => {
    const prose = () =>
      Response.json({ content: [{ type: "text", text: "Sure, here is the receipt" }], usage: USAGE });
    fetchMock.mockResolvedValueOnce(prose()).mockResolvedValueOnce(prose());

    await expect(extractReceipt([URL_ONE], "k")).resolves.toEqual({ ok: false, reason: "model-error" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a currency symbol", "$19.50"],
    ["a thousands separator", "1,950.00"],
    ["three decimals", "19.999"],
    ["a trailing dot", "19."],
    ["no digits before the point", ".50"],
    ["exponent notation", "1e3"],
    ["a leading plus", "+5.00"],
    ["whitespace", " 5.00"],
    ["words", "free"],
    ["an empty string", ""],
  ])("rejects a price with %s as a schema violation", async (_why, price) => {
    const items = [{ label: "Thing", price, confidence: 1 }];
    fetchMock.mockImplementation(async () => toolUseResponse(withOverrides({ items })));

    await expect(extractReceipt([URL_ONE], "k")).resolves.toEqual({ ok: false, reason: "model-error" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a numeric price, because a JSON number has already been through a float", async () => {
    const items = [{ label: "Thing", price: 19.5, confidence: 1 }];
    fetchMock.mockImplementation(async () => toolUseResponse(withOverrides({ items })));

    await expect(extractReceipt([URL_ONE], "k")).resolves.toEqual({ ok: false, reason: "model-error" });
  });

  it("rejects an unparseable tax or printed total", async () => {
    fetchMock.mockImplementation(async () => toolUseResponse(withOverrides({ tax: "twenty" })));
    await expect(extractReceipt([URL_ONE], "k")).resolves.toEqual({ ok: false, reason: "model-error" });

    fetchMock.mockImplementation(async () => toolUseResponse(withOverrides({ printed_total: "$273.82" })));
    await expect(extractReceipt([URL_ONE], "k")).resolves.toEqual({ ok: false, reason: "model-error" });
  });

  it.each([
    ["above 1", 1.5],
    ["below 0", -0.1],
    ["not a number", "high"],
    ["NaN", Number.NaN],
  ])("rejects a confidence that is %s", async (_why, confidence) => {
    const items = [{ label: "Thing", price: "5.00", confidence }];
    fetchMock.mockImplementation(async () => toolUseResponse(withOverrides({ items })));

    await expect(extractReceipt([URL_ONE], "k")).resolves.toEqual({ ok: false, reason: "model-error" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an item with no label", async () => {
    const items = [{ price: "5.00", confidence: 1 }];
    fetchMock.mockImplementation(async () => toolUseResponse(withOverrides({ items })));

    await expect(extractReceipt([URL_ONE], "k")).resolves.toEqual({ ok: false, reason: "model-error" });
  });

  it("reports a model error rather than a crash when the credit balance is empty", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." },
        },
        { status: 400 },
      ),
    );

    await expect(extractReceipt([URL_ONE], "k")).resolves.toEqual({ ok: false, reason: "model-error" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a model error without retrying when the API is down", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529 }),
    );

    await expect(extractReceipt([URL_ONE], "k")).resolves.toEqual({ ok: false, reason: "model-error" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up with a model error, without retrying, once the caller's deadline passes", async () => {
    // Behaves like a real fetch that never answers: it only ends when aborted.
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    const deadline = new AbortController();

    const result = extractReceipt([URL_ONE], "k", { signal: deadline.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    deadline.abort(new DOMException("deadline", "TimeoutError"));

    await expect(result).resolves.toEqual({ ok: false, reason: "model-error" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a malformed reply once the deadline has passed", async () => {
    const deadline = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      deadline.abort(new DOMException("deadline", "TimeoutError"));
      return toolUseResponse({ not: "the schema" });
    });

    await expect(extractReceipt([URL_ONE], "k", { signal: deadline.signal })).resolves.toEqual({
      ok: false,
      reason: "model-error",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still uses a good answer that arrived just as the deadline passed", async () => {
    const deadline = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      deadline.abort(new DOMException("deadline", "TimeoutError"));
      return toolUseResponse(SAIGON_TOOL_INPUT);
    });

    const result = await extractReceipt([URL_ONE], "k", { signal: deadline.signal });

    expect(result).toMatchObject({ ok: true, reconciles: true });
  });

  it("reports a model error when the network call itself fails", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(extractReceipt([URL_ONE], "k")).resolves.toEqual({ ok: false, reason: "model-error" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs the usage block of the first call, once", async () => {
    fetchMock
      .mockResolvedValueOnce(toolUseResponse(withOverrides({ items: "none" })))
      .mockResolvedValueOnce(toolUseResponse(SAIGON_TOOL_INPUT));

    await extractReceipt([URL_ONE], "k");

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0].join(" ")).toContain(JSON.stringify(USAGE));
  });

  it("never logs the API key or the image URL", async () => {
    fetchMock.mockResolvedValueOnce(toolUseResponse(SAIGON_TOOL_INPUT));

    await extractReceipt([URL_ONE], "sk-secret-key");

    const logged = logSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain("sk-secret-key");
    expect(logged).not.toContain(URL_ONE);
  });
});
