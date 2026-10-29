import { PAY_METHODS, type PayMethod } from "../web/paylink";

export interface PaymentHandle {
  method: PayMethod;
  handle: string;
}

// Callers validate first: whatever is stored here goes straight into a link.
export async function setPaymentHandle(db: D1Database, userId: string, method: PayMethod, handle: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO payment_handles (user_id, method, handle, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, method) DO UPDATE SET handle = excluded.handle, updated_at = excluded.updated_at`,
    )
    .bind(userId, method, handle, new Date().toISOString())
    .run();
}

// Always in the same method order, so the pay buttons never shuffle between taps.
export async function getPaymentHandles(db: D1Database, userId: string): Promise<PaymentHandle[]> {
  const { results } = await db
    .prepare("SELECT method, handle FROM payment_handles WHERE user_id = ?")
    .bind(userId)
    .all<PaymentHandle>();
  return [...results].sort((a, b) => PAY_METHODS.indexOf(a.method) - PAY_METHODS.indexOf(b.method));
}
