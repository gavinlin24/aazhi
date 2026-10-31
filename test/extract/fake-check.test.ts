import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { looksFake } from "../../src/extract/fake-check";
import type { ReadPermit } from "../../src/extract/read-limit";

const PERMIT = { imageUrls: ["https://cdn.discordapp.com/attachments/1/2/receipt.jpg"] } as unknown as ReadPermit;
const verdict = (fields: Record<string, unknown>) => Response.json({ content: [{ type: "text", text: JSON.stringify(fields) }], usage: {} });
const clean = { medium: "photo_of_paper", edited: false, till_printed: true };

let answer: () => Response | Promise<Response>;
let sent: { model?: string; output_config?: unknown } | null;

beforeEach(() => {
  sent = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (_: unknown, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return answer();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the fake check", () => {
  it("passes a receipt that looks like paper from a till", async () => {
    answer = () => verdict(clean);
    expect(await looksFake(PERMIT, "key")).toBe(false);
  });

  // A screenshot never came from a till, so that answer can't count against it.
  it("passes a digital receipt", async () => {
    answer = () => verdict({ medium: "digital_receipt", edited: false, till_printed: false });
    expect(await looksFake(PERMIT, "key")).toBe(false);
  });

  it.each([
    ["imitates paper", { ...clean, medium: "imitation_of_paper" }],
    ["was edited", { ...clean, edited: true }],
    ["is a digital receipt that was edited", { medium: "digital_receipt", edited: true, till_printed: false }],
    ["is on paper but didn't come from a till", { ...clean, till_printed: false }],
  ])("flags one that %s", async (_, fields) => {
    answer = () => verdict(fields);
    expect(await looksFake(PERMIT, "key")).toBe(true);
  });

  // Flagging posts someone's receipt to the whole server, so an outage must
  // never do that to them.
  it.each([
    ["the API refuses", () => new Response("no", { status: 500 })],
    ["the reply isn't JSON", () => Response.json({ content: [{ type: "text", text: "looks fine to me" }] })],
    ["the reply is empty", () => Response.json({ content: [] })],
    ["the network drops", () => Promise.reject(new Error("gone"))],
  ])("doesn't flag when %s", async (_, failing) => {
    answer = failing;
    expect(await looksFake(PERMIT, "key")).toBe(false);
  });

  it("asks Sonnet for a structured verdict, since it refuses a forced tool", async () => {
    answer = () => verdict(clean);
    await looksFake(PERMIT, "key");
    expect(sent?.model).toBe("claude-sonnet-5-5");
    expect(sent?.output_config).toMatchObject({ format: { type: "json_schema" } });
  });
});
