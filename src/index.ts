import { Hono, type Context } from "hono";
import type { APIInteraction } from "discord-api-types/v10";
import { getBill, getBillSnapshot, listLogs } from "./db/bills";
import { stampRows, stampsHeld, unseenStamps } from "./db/stamps";
import { hasBillHere, personProfile, personSummary, serverBoards, type BoardName, type BoardSpan } from "./db/stats";
import { handleInteraction } from "./discord/interactions";
import { MAX_NAME } from "./discord/handlers/profile";
import { clip } from "./discord/notices";
import { guildName } from "./discord/rest";
import { verifyRequest } from "./discord/verify";
import type { Env } from "./env";
import { api } from "./web/api";
import { logsApi } from "./web/logs";
import { renderBillGone, renderBillNotFound, renderLinkRefused, renderPage } from "./web/page";
import { STAMP_FONT, STAMP_FONT_PATH } from "./web/fonts";
import { renderBoards, renderBoardsRefused, renderNoBills, renderPersonRefused, renderProfile, renderProfileRefused, renderStamps, type Viewer } from "./web/profile";
import { pageData } from "./web/state";
import { checkMemberProof, mintViewerToken, readToken, readViewerToken } from "./web/token";

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
  const { bill, input, participants } = snapshot;
  if (bill.kind === "log" && grant.participantId !== bill.payerId) return page(renderLinkRefused(), 403);
  if (bill.status === "superseded" || bill.status === "deleted") return page(renderBillGone(bill), 410);

  const { result, extras } = await pageData(c.env.DB, snapshot, grant.participantId);
  return page(renderPage(bill, result, input.items, participants, grant.participantId, extras), 200);
});

app.get(STAMP_FONT_PATH, () => {
  const bytes = Uint8Array.from(atob(STAMP_FONT), (char) => char.charCodeAt(0));
  return new Response(bytes, { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=604800" } });
});

// The "See your stamps" link on a bill page's Ceremony. A bill link can't
// open a profile page, so it trades itself for a viewer link to the same person.
app.get("/b/:billId/stamps", async (c) => {
  const billId = c.req.param("billId");
  const nowMs = Date.now();
  const grant = await readToken(c.req.query("t") ?? "", c.env.TOKEN_SIGNING_KEY, nowMs);
  if (!grant || grant.billId !== billId) return page(renderLinkRefused(), 403);
  const bill = await getBill(c.env.DB, billId);
  if (!bill) return page(renderBillNotFound(), 404);
  const server = await guildName(bill.guildId, c.env);
  const token = await mintViewerToken(bill.guildId, grant.participantId, server && clip(server, MAX_NAME), c.env.TOKEN_SIGNING_KEY, nowMs);
  return new Response(null, {
    status: 302,
    headers: {
      location: `/g/${encodeURIComponent(bill.guildId)}/stamps?t=${token}`,
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
});

// The page's script talks to these with the same token, as a bearer header.
app.route("/b", api);

const BOARDS: readonly string[] = ["hosted", "spent", "visits"] satisfies BoardName[];

// As with a bill, the token is checked first and every failure looks the same.
// The server in the path must be the one in the token: the numbers cross
// servers, but a link only ever opens from the server it was asked for in.
async function viewerOf(c: Context<{ Bindings: Env }>): Promise<Viewer | null> {
  const token = c.req.query("t") ?? "";
  const grant = await readViewerToken(token, c.env.TOKEN_SIGNING_KEY, Date.now());
  if (!grant || grant.guildId !== c.req.param("guildId")) return null;
  const board = c.req.query("board") ?? "";
  return {
    ...grant,
    token,
    proof: c.req.query("m") ?? null,
    unseen: await unseenStamps(c.env.DB, grant.guildId, grant.viewerId),
    place: {
      board: (BOARDS.includes(board) ? board : "hosted") as BoardName,
      span: (c.req.query("span") === "all" ? "all" : "month") as BoardSpan,
    },
    fromBoard: c.req.query("from") === "leaderboard",
  };
}

// Numbers cross servers, so this is the check that stops a link from walking
// to any Discord id at all: only yourself, someone with a bill here, or someone
// /profile @name just vouched for.
async function mayOpen(c: Context<{ Bindings: Env }>, viewer: Viewer, person: string): Promise<boolean> {
  if (person === viewer.viewerId) return true;
  if (viewer.proof && (await checkMemberProof(viewer.proof, viewer.token, person, c.env.TOKEN_SIGNING_KEY))) return true;
  return hasBillHere(c.env.DB, viewer.guildId, person);
}

async function profilePage(c: Context<{ Bindings: Env }>, who: (viewer: Viewer) => string): Promise<Response> {
  const viewer = await viewerOf(c);
  if (!viewer) return page(renderProfileRefused(), 403);
  const nowMs = Date.now();
  const person = who(viewer);
  if (!(await mayOpen(c, viewer, person))) return page(renderPersonRefused(), 403);
  const profile = await personProfile(c.env.DB, viewer.guildId, person, nowMs);
  if (!profile) return page(renderNoBills(viewer, person === viewer.viewerId), 200);
  const [logs, stamps] = await Promise.all([person === viewer.viewerId ? listLogs(c.env.DB, person) : [], stampsHeld(c.env.DB, viewer.guildId, person)]);
  return page(renderProfile(profile, viewer, nowMs, logs, stamps), 200);
}

async function stampsPage(c: Context<{ Bindings: Env }>, who: (viewer: Viewer) => string): Promise<Response> {
  const viewer = await viewerOf(c);
  if (!viewer) return page(renderProfileRefused(), 403);
  const person = who(viewer);
  if (!(await mayOpen(c, viewer, person))) return page(renderPersonRefused(), 403);
  const summary = await personSummary(c.env.DB, viewer.guildId, person);
  if (!summary) return page(renderNoBills(viewer, person === viewer.viewerId), 200);
  return page(renderStamps({ ...summary, id: person }, await stampRows(c.env.DB, viewer.guildId, person), viewer, Date.now()), 200);
}

app.get("/g/:guildId", (c) => profilePage(c, (viewer) => viewer.viewerId));
app.get("/g/:guildId/u/:userId", (c) => profilePage(c, () => c.req.param("userId")!));

app.get("/g/:guildId/stamps", (c) => stampsPage(c, (viewer) => viewer.viewerId));
app.get("/g/:guildId/u/:userId/stamps", (c) => stampsPage(c, () => c.req.param("userId")!));

app.get("/g/:guildId/boards", async (c) => {
  const viewer = await viewerOf(c);
  if (!viewer) return page(renderBoardsRefused(), 403);
  return page(renderBoards(await serverBoards(c.env.DB, viewer.guildId, Date.now()), viewer), 200);
});

app.route("/g", logsApi);

export default app;
