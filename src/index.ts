import { Hono } from "hono";
import type { APIInteraction } from "discord-api-types/v10";
import { handleInteraction } from "./discord/interactions";
import { verifyRequest } from "./discord/verify";
import type { Env } from "./env";

const app = new Hono<{ Bindings: Env }>();

app.post("/interactions", async (c) => {
  // The endpoint is public, so the signature is checked over the raw bytes
  // before anything is parsed; re-serialising parsed JSON would not match.
  const rawBody = await c.req.text();
  const verified = await verifyRequest(
    rawBody,
    c.req.header("x-signature-ed25519") ?? null,
    c.req.header("x-signature-timestamp") ?? null,
    c.env.DISCORD_PUBLIC_KEY,
  );
  if (!verified) return c.text("invalid request signature", 401);

  let interaction: APIInteraction;
  try {
    interaction = JSON.parse(rawBody) as APIInteraction;
  } catch {
    return c.text("malformed body", 400);
  }
  return handleInteraction(interaction, c.env, c.executionCtx as ExecutionContext);
});

export default app;
