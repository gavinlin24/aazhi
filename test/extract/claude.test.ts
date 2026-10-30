import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractReceipt, reconciles, type Extraction } from "../../src/extract/claude";
import { EXTRACT_TOOL_NAME, parseToolInput } from "../../src/extract/schema";
import { LA_PALMA, MENSHO, PATTY_SHACK } from "../fixtures/modifiers";
import { SAIGON } from "../fixtures/saigon";

const SAIGON_EXTRACTION: Extraction = {
  place: "Saigon Kitchen",
  billDate: "2026-10-28",
  items: SAIGON.items.map((item) => ({ label: item.label, cents: item.cents, confidence: 0.95 })),
  discountCents: 0,
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
  discount: null,
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
      discountCents: 0,
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
      discountCents: 0,
      taxCents: 130,
      printedTotalCents: 1430,
    };
    expect(reconciles(comped)).toEqual({ ok: true, discrepancyCents: null });
  });

  it("takes a whole-bill discount off the items before checking the total", () => {
    expect(reconciles({ ...SAIGON_EXTRACTION, discountCents: 2515, printedTotalCents: 27382 - 2515 })).toEqual({
      ok: true,
      discrepancyCents: null,
    });
    // The same discount missed by the read shows as the gap.
    expect(reconciles({ ...SAIGON_EXTRACTION, printedTotalCents: 27382 - 2515 })).toEqual({ ok: false, discrepancyCents: 2515 });
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

  it("keeps a whole-bill discount out of the items, as money off", async () => {
    fetchMock.mockResolvedValueOnce(toolUseResponse(withOverrides({ discount: "-25.15", printed_total: "248.67" })));

    const result = await extractReceipt([URL_ONE], "k");

    expect(result).toEqual({
      ok: true,
      extraction: { ...SAIGON_EXTRACTION, discountCents: 2515, printedTotalCents: 24867 },
      reconciles: true,
      discrepancyCents: null,
    });
  });

  it("reads a discount printed without a minus sign as money off too", async () => {
    fetchMock.mockResolvedValueOnce(toolUseResponse(withOverrides({ discount: "25.15", printed_total: "248.67" })));
    await expect(extractReceipt([URL_ONE], "k")).resolves.toMatchObject({ extraction: { discountCents: 2515 }, reconciles: true });
  });

  it("takes a missing discount as none", async () => {
    const { discount: _discount, ...withoutDiscount } = SAIGON_TOOL_INPUT;
    fetchMock.mockResolvedValueOnce(toolUseResponse(withoutDiscount));
    await expect(extractReceipt([URL_ONE], "k")).resolves.toMatchObject({ extraction: { discountCents: 0 }, reconciles: true });
  });

  it("asks for whole-bill discounts apart from the items, and a dish's own discount under it", async () => {
    fetchMock.mockResolvedValueOnce(toolUseResponse(SAIGON_TOOL_INPUT));
    await extractReceipt([URL_ONE], "k");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools[0].input_schema.required).toContain("discount");
    const prompt = body.messages[0].content.at(-1).text;
    expect(prompt).toMatch(/whole bill .* is not an item\. Put the total of all of them in discount/);
    expect(prompt).toMatch(/directly under one item belongs to that item/);
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

  it("rejects an unparseable tax, discount or printed total", async () => {
    fetchMock.mockImplementation(async () => toolUseResponse(withOverrides({ tax: "twenty" })));
    await expect(extractReceipt([URL_ONE], "k")).resolves.toEqual({ ok: false, reason: "model-error" });

    fetchMock.mockImplementation(async () => toolUseResponse(withOverrides({ printed_total: "$273.82" })));
    await expect(extractReceipt([URL_ONE], "k")).resolves.toEqual({ ok: false, reason: "model-error" });

    fetchMock.mockImplementation(async () => toolUseResponse(withOverrides({ discount: "10%" })));
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

describe("modifiers", () => {
  async function read(input: unknown) {
    fetchMock.mockResolvedValueOnce(toolUseResponse(input));
    const result = await extractReceipt([URL_ONE], "k");
    if (!result.ok) throw new Error(`read failed: ${result.reason}`);
    return result;
  }

  const lines = (result: Awaited<ReturnType<typeof read>>) =>
    result.extraction.items.map((i) => [i.label, i.cents, i.addons]);
  const addon = (label: string, cents = 0) => ({ label, cents });

  it("keeps a dish and its charged add-ons one line, priced together, each add-on with its own price", async () => {
    const result = await read(PATTY_SHACK);

    expect(lines(result)).toEqual([
      ["Classic Burger", 1950, [addon("Medium Rare"), addon("Extra Patty", 300), addon("Add Bacon", 250), addon("No Onions")]],
      ["Veggie Burger", 1500, [addon("Gluten Free Bun", 200), addon("No Pickles")]],
      ["Fries", 650, [addon("Truffle Oil", 150)]],
      ["Soda", 600, undefined],
    ]);
    expect(result).toMatchObject({ reconciles: true, discrepancyCents: null });
  });

  it("reads + and - marked modifiers the same way", async () => {
    const result = await read(LA_PALMA);

    expect(lines(result)).toEqual([
      ["Burrito Bowl", 1825, [addon("Guacamole", 225), addon("Extra Chicken", 350), addon("No rice")]],
      ["Tacos (3)", 1150, [addon("Cheese", 100)]],
      ["Horchata", 400, undefined],
      ["Chips & Salsa", 450, undefined],
    ]);
    expect(result.reconciles).toBe(true);
  });

  it("keeps an already included add-on's amount and takes it out of the dish's own price, so the total stays as printed", async () => {
    const result = await read(MENSHO);

    expect(lines(result)).toEqual([
      ["Tonkotsu Ramen", 1900, [addon("Extra Chashu"), addon("Soft Egg"), addon("Spicy")]],
      ["Gyoza", 800, undefined],
      ["Shoyu Ramen", 1600, [addon("Add Corn", 100)]],
      ["Sapporo", 700, undefined],
    ]);
    expect(result).toMatchObject({ reconciles: true, discrepancyCents: null });
  });

  it("keeps included add-ons as names only when their amounts are more than the dish they are part of", () => {
    const input = {
      ...PATTY_SHACK,
      items: [{ label: "Milk tea", price: "1.00", modifiers: [{ label: "Boba", price: "5.00" }], confidence: 1 }],
      tax: "0.00",
      printed_total: "1.00",
    };

    const parsed = parseToolInput(input);

    expect(parsed).toMatchObject({ modifiersIncluded: { items: [{ cents: 100, addons: [addon("Boba")] }] } });
  });

  it("keeps the charged reading, and its gap, when neither reading matches the printed total", async () => {
    const result = await read({ ...MENSHO, printed_total: "60.00" });

    expect(result.extraction.items.find((i) => i.label === "Shoyu Ramen")).toMatchObject({ cents: 1700, addons: [addon("Add Corn", 100)] });
    expect(result).toMatchObject({ reconciles: false, discrepancyCents: -456 });
  });

  it("does not fail the whole receipt over an unpriced modifier read as an empty price", async () => {
    const items = PATTY_SHACK.items.map((item, i) =>
      i === 0 ? { ...item, modifiers: item.modifiers.map((m) => (m.price === null ? { ...m, price: "" } : m)) } : item,
    );
    const result = await read({ ...PATTY_SHACK, items });

    expect(result.extraction.items[0]).toMatchObject({
      cents: 1950,
      addons: [addon("Medium Rare"), addon("Extra Patty", 300), addon("Add Bacon", 250), addon("No Onions")],
    });
    expect(result.reconciles).toBe(true);
  });

  it("takes a negative modifier off the line", () => {
    const input = {
      ...PATTY_SHACK,
      items: [{ label: "Steak", price: "30.00", modifiers: [{ label: "Sub salad", price: "-1.00" }], confidence: 1 }],
    };

    const parsed = parseToolInput(input);

    expect(parsed).toMatchObject({ kind: "extraction", extraction: { items: [{ cents: 2900, addons: [addon("Sub salad", -100)] }] } });
  });

  it("names a priced modifier read without a name, so the line still adds up to its add-ons", () => {
    const input = {
      ...PATTY_SHACK,
      items: [{ label: "Burger", price: "14.00", modifiers: [{ label: " ", price: "3.00" }, { label: "", price: null }], confidence: 1 }],
    };

    const parsed = parseToolInput(input);

    expect(parsed).toMatchObject({ extraction: { items: [{ cents: 1700, addons: [addon("Add-on", 300)] }] } });
  });

  it.each([
    ["a modifier price that is not a decimal string", [{ label: "Extra patty", price: "three" }]],
    ["a modifier price sent as a number", [{ label: "Extra patty", price: 3 }]],
    ["a modifier with no label", [{ price: "3.00" }]],
    ["modifiers that are not a list", "Extra patty"],
  ])("rejects %s", (_, modifiers) => {
    const input = { ...PATTY_SHACK, items: [{ label: "Burger", price: "14.00", modifiers, confidence: 1 }] };

    expect(parseToolInput(input)).toEqual({ kind: "invalid" });
  });

  it("offers the included reading only when some modifier carries a price", () => {
    expect(parseToolInput(SAIGON_TOOL_INPUT)).not.toHaveProperty("modifiersIncluded");
    expect(parseToolInput(MENSHO)).toHaveProperty("modifiersIncluded");
  });

  it("asks the model for modifiers under their dish rather than as lines of their own", async () => {
    fetchMock.mockResolvedValueOnce(toolUseResponse(SAIGON_TOOL_INPUT));

    await extractReceipt([URL_ONE], "k");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const item = body.tools[0].input_schema.properties.items.items;
    expect(item.required).toContain("modifiers");
    expect(item.properties.modifiers.items.required).toEqual(["label", "price"]);
  });
});
