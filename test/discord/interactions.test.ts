import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import {
  commandHandlers,
  componentHandlers,
  handleInteraction,
  type InteractionHandler,
} from "../../src/discord/interactions";
import { generateKeypair, signedRequest, testEnv, type TestKeypair } from "./helpers";

const EPHEMERAL = 1 << 6;

async function post(request: Request, publicKeyHex: string): Promise<Response> {
  return app.fetch(request, testEnv(publicKeyHex), createExecutionContext());
}

function interaction(overrides: Record<string, unknown>) {
  return { id: "1", application_id: "2", token: "t", version: 1, ...overrides };
}

// Later tasks fill these tables with real handlers; tests register stand-ins
// and put the real tables back afterwards.
const realCommands = { ...commandHandlers };
const realComponents = { ...componentHandlers };

function restore(table: Record<string, InteractionHandler>, original: Record<string, InteractionHandler>) {
  for (const key of Object.keys(table)) delete table[key];
  Object.assign(table, original);
}

afterEach(() => {
  vi.restoreAllMocks();
  restore(commandHandlers, realCommands);
  restore(componentHandlers, realComponents);
});

describe("POST /interactions signature gate", () => {
  let keypair: TestKeypair;
  const ready = generateKeypair().then((k) => (keypair = k));

  it("rejects a request with a bad signature before parsing the body", async () => {
    await ready;
    const parse = vi.spyOn(JSON, "parse");
    const request = await signedRequest(keypair, { type: 1 });
    request.headers.set("x-signature-ed25519", "00".repeat(64));

    const response = await post(request, keypair.publicKeyHex);

    expect(response.status).toBe(401);
    expect(parse).not.toHaveBeenCalled();
  });

  it("does parse the body once the signature is good (so the spy above can fail)", async () => {
    await ready;
    const parse = vi.spyOn(JSON, "parse");

    const response = await post(await signedRequest(keypair, { type: 1 }), keypair.publicKeyHex);

    expect(response.status).toBe(200);
    expect(parse).toHaveBeenCalled();
  });

  it("rejects a request with a missing signature header", async () => {
    await ready;
    const parse = vi.spyOn(JSON, "parse");
    const request = await signedRequest(keypair, { type: 1 });
    request.headers.delete("x-signature-ed25519");

    const response = await post(request, keypair.publicKeyHex);

    expect(response.status).toBe(401);
    expect(parse).not.toHaveBeenCalled();
  });

  it("rejects a request with a missing timestamp header", async () => {
    await ready;
    const parse = vi.spyOn(JSON, "parse");
    const request = await signedRequest(keypair, { type: 1 });
    request.headers.delete("x-signature-timestamp");

    const response = await post(request, keypair.publicKeyHex);

    expect(response.status).toBe(401);
    expect(parse).not.toHaveBeenCalled();
  });

  it("answers 401, not 500, when the configured public key is malformed", async () => {
    await ready;
    const parse = vi.spyOn(JSON, "parse");

    const response = await post(await signedRequest(keypair, { type: 1 }), "not-a-key");

    expect(response.status).toBe(401);
    expect(parse).not.toHaveBeenCalled();
  });

  it("rejects a body tampered with after signing", async () => {
    await ready;
    const original = await signedRequest(keypair, { type: 1 });
    const tampered = new Request(original.url, {
      method: "POST",
      headers: original.headers,
      body: JSON.stringify({ type: 2, data: { name: "split" } }),
    });

    const response = await post(tampered, keypair.publicKeyHex);

    expect(response.status).toBe(401);
  });
});

describe("handleInteraction routing", () => {
  let keypair: TestKeypair;
  const ready = generateKeypair().then((k) => (keypair = k));

  it("answers Discord's PING with a PONG", async () => {
    await ready;

    const response = await post(await signedRequest(keypair, { type: 1 }), keypair.publicKeyHex);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ type: 1 });
  });

  it("routes an application command to the handler registered under its name", async () => {
    await ready;
    const handler: InteractionHandler = vi.fn(async () => Response.json({ type: 5 }));
    commandHandlers["split"] = handler;

    const body = interaction({ type: 2, data: { id: "9", name: "split", type: 1 } });
    const response = await post(await signedRequest(keypair, body), keypair.publicKeyHex);

    expect(await response.json()).toEqual({ type: 5 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler).mock.calls[0]?.[0]).toMatchObject({ type: 2, data: { name: "split" } });
  });

  it("routes a message command by its display name", async () => {
    await ready;
    const handler: InteractionHandler = vi.fn(async () => Response.json({ type: 5 }));
    commandHandlers["Split this receipt"] = handler;

    const body = interaction({ type: 2, data: { id: "9", name: "Split this receipt", type: 3 } });
    await post(await signedRequest(keypair, body), keypair.publicKeyHex);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("routes a component to the handler whose prefix its custom_id starts with", async () => {
    await ready;
    const open: InteractionHandler = vi.fn(async () => Response.json({ type: 6 }));
    const confirm: InteractionHandler = vi.fn(async () => Response.json({ type: 6 }));
    componentHandlers["open:"] = open;
    componentHandlers["confirm:"] = confirm;

    const body = interaction({ type: 3, data: { custom_id: "confirm:bill-123:7", component_type: 2 } });
    await post(await signedRequest(keypair, body), keypair.publicKeyHex);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it("answers an unregistered command with a polite ephemeral message, not an error", async () => {
    await ready;

    const body = interaction({ type: 2, data: { id: "9", name: "nope", type: 1 } });
    const response = await post(await signedRequest(keypair, body), keypair.publicKeyHex);

    expect(response.status).toBe(200);
    const json = (await response.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(EPHEMERAL);
    expect(json.data.content).toMatch(/not supported/i);
  });

  it("answers an unregistered component the same way", async () => {
    await ready;

    const body = interaction({ type: 3, data: { custom_id: "mystery:1", component_type: 2 } });
    const response = await post(await signedRequest(keypair, body), keypair.publicKeyHex);

    const json = (await response.json()) as { type: number; data: { flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(EPHEMERAL);
  });

  it("answers a modal submit it has no handler for the same way", async () => {
    await ready;

    const body = interaction({ type: 5, data: { custom_id: "x", components: [] } });
    const response = await post(await signedRequest(keypair, body), keypair.publicKeyHex);

    const json = (await response.json()) as { type: number; data: { flags: number } };
    expect(response.status).toBe(200);
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(EPHEMERAL);
  });

  it("handleInteraction can be called directly with a PING", async () => {
    const response = await handleInteraction(
      interaction({ type: 1 }) as never,
      testEnv("00"),
      createExecutionContext(),
      "https://aazhi.test",
    );

    expect(await response.json()).toEqual({ type: 1 });
  });
});

describe("other routes", () => {
  it("does not expose GET /interactions", async () => {
    const response = await app.fetch(
      new Request("https://aazhi.test/interactions"),
      testEnv("00"),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
  });
});
