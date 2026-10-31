import { Hono, type Context } from "hono";
import { deleteBill, discardLog, getBill, setLogPlace, type BillRow } from "../db/bills";
import { markStampsSeen } from "../db/stamps";
import { onePlace, removeLogPost, renameLogPost } from "../discord/log-post";
import type { Env } from "../env";
import { readViewerToken } from "./token";

export const MAX_PLACE = 80;

// A rename is decoration on the post, so a failed edit is logged and the new
// name stands on the profile and the page.
export async function renamePost(bill: BillRow, env: Env): Promise<void> {
  await renameLogPost(bill, env).catch((error) => console.error("could not rename a log's post", error));
}

// A draft was never anything, so it leaves no row. A logged one is undone like a
// deleted bill, and takes its post with it. The log is gone even if the post
// can't be, which `postLeft` tells the person.
export async function removeLog(env: Env, bill: BillRow): Promise<{ deleted: true; postLeft?: true }> {
  if (bill.status === "draft") {
    await discardLog(env.DB, bill.id);
    return { deleted: true };
  }
  await deleteBill(env.DB, bill.id, 0);
  return (await removeLogPost(bill, env)) ? { deleted: true } : { deleted: true, postLeft: true };
}

// The profile's way in, once the page's 30-minute link has run out. It can't use
// a bill token, which only /log hands out, so it goes on the viewer's own:
// a log belongs to its person wherever it was logged, and that is all it checks.
async function ownedLog(c: Context<{ Bindings: Env }>): Promise<BillRow | null> {
  const match = /^Bearer ([^\s]+)$/.exec(c.req.header("authorization") ?? "");
  const grant = match ? await readViewerToken(match[1]!, c.env.TOKEN_SIGNING_KEY, Date.now()) : null;
  if (!grant || grant.guildId !== c.req.param("guildId")) return null;
  const bill = await getBill(c.env.DB, c.req.param("billId")!);
  return bill?.kind === "log" && bill.status === "confirmed" && bill.payerId === grant.viewerId ? bill : null;
}

const NOT_YOURS = "This link has expired or that log is gone. Run /profile for a fresh one.";

function answer(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export const logsApi = new Hono<{ Bindings: Env }>();

// The Ceremony on a profile page, which holds a viewer token and no bill.
logsApi.post("/:guildId/stamps/seen", async (c) => {
  const match = /^Bearer ([^\s]+)$/.exec(c.req.header("authorization") ?? "");
  const grant = match ? await readViewerToken(match[1]!, c.env.TOKEN_SIGNING_KEY, Date.now()) : null;
  if (!grant || grant.guildId !== c.req.param("guildId")) return answer({ error: NOT_YOURS }, 403);
  const body = await c.req.json<{ keys?: unknown }>().catch(() => null);
  const keys = Array.isArray(body?.keys) ? body.keys.filter((key): key is string => typeof key === "string") : [];
  await markStampsSeen(c.env.DB, grant.guildId, grant.viewerId, keys);
  return answer({ seen: true });
});

logsApi.patch("/:guildId/logs/:billId", async (c) => {
  const bill = await ownedLog(c);
  if (!bill) return answer({ error: NOT_YOURS }, 403);
  const body = await c.req.json<{ place?: unknown }>().catch(() => null);
  const place = typeof body?.place === "string" ? onePlace(body.place) : "";
  if (place.length === 0) return answer({ error: `Give this place a name of 1 to ${MAX_PLACE} characters.` }, 400);
  if (!(await setLogPlace(c.env.DB, bill.id, place))) return answer({ error: NOT_YOURS }, 403);
  c.executionCtx.waitUntil(renamePost({ ...bill, place }, c.env));
  return answer({ place });
});

logsApi.delete("/:guildId/logs/:billId", async (c) => {
  const bill = await ownedLog(c);
  if (!bill) return answer({ error: NOT_YOURS }, 403);
  return answer(await removeLog(c.env, bill));
});
