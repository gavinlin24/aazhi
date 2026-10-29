import { Hono } from "hono";
import type { APIInteraction } from "discord-api-types/v10";
import { getBillSnapshot } from "./db/bills";
import { handleInteraction } from "./discord/interactions";
import { verifyRequest } from "./discord/verify";
import type { Env } from "./env";
import { api } from "./web/api";
import { renderBillGone, renderBillNotFound, renderLinkRefused, renderPage } from "./web/page";
import { pageResult } from "./web/state";
import { readToken } from "./web/token";

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
  return handleInteraction(interaction, c.env, c.executionCtx as ExecutionContext, new URL(c.req.url).origin);
});

// The token rides in the URL, so no page may leak that URL onward through a
// Referer header or leave a copy in a shared cache.
function page(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

// The token is checked before the bill is even looked up, so a visitor without
// a valid link cannot tell an existing bill from a missing one.
app.get("/b/:billId", async (c) => {
  const billId = c.req.param("billId");
  const grant = await readToken(c.req.query("t") ?? "", c.env.TOKEN_SIGNING_KEY, Date.now());
  if (!grant || grant.billId !== billId) return page(renderLinkRefused(), 403);

  const snapshot = await getBillSnapshot(c.env.DB, billId);
  if (!snapshot) return page(renderBillNotFound(), 404);
  const { bill, input, participants, hasPayments, paid } = snapshot;
  if (bill.status === "superseded" || bill.status === "deleted") return page(renderBillGone(bill.status), 410);

  return page(renderPage(bill, await pageResult(c.env.DB, snapshot), input.items, participants, grant.participantId, { hasPayments, paid }), 200);
});

// The page's script talks to these with the same token, as a bearer header.
app.route("/b", api);

export default app;
