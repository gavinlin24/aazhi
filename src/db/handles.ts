import type { ParticipantId } from "../money/types";

// Callers validate first: whatever is stored here goes straight into a link.
export async function setVenmoHandle(db: D1Database, userId: ParticipantId, handle: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO payment_handles (user_id, method, handle, updated_at) VALUES (?, 'venmo', ?, ?)
       ON CONFLICT (user_id, method) DO UPDATE SET handle = excluded.handle, updated_at = excluded.updated_at`,
    )
    .bind(userId, handle, new Date().toISOString())
    .run();
}

// Rows for the other apps are left in place, since narrowing the table's CHECK
// would mean rebuilding it, but nothing reads them: Venmo is the only app whose
// link fills in the amount and note.
export async function getVenmoHandles(db: D1Database, userIds: ParticipantId[]): Promise<Map<ParticipantId, string>> {
  const { results } = await db
    .prepare(`SELECT user_id, handle FROM payment_handles WHERE method = 'venmo' AND user_id IN (${userIds.map(() => "?").join(", ")})`)
    .bind(...userIds)
    .all<{ user_id: string; handle: string }>();
  return new Map(results.map((row) => [row.user_id, row.handle]));
}
