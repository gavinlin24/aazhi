const WRITE = /^\s*(INSERT|UPDATE|DELETE)\b/i;

// A D1 handle on which `sneak` lands at the worst moment: after the caller has
// read the bill, just before its first write reaches the database. Only
// statements that write are watched, so whatever the caller reads up front
// (with or without a batch) still sees the bill as it was.
export function beforeFirstWrite(
  db: D1Database,
  sneak: (db: D1Database) => Promise<unknown>,
): { db: D1Database; raced: () => boolean } {
  const writes = new WeakSet<object>();
  let fired = false;

  function track(statement: D1PreparedStatement): D1PreparedStatement {
    writes.add(statement);
    const bind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => track(bind(...values));
    const run = statement.run.bind(statement);
    statement.run = async <T>() => {
      await fire();
      return run<T>();
    };
    return statement;
  }

  async function fire() {
    if (fired) return;
    fired = true;
    await sneak(db);
  }

  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          return WRITE.test(sql) ? track(statement) : statement;
        };
      }
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (statements.some((s) => writes.has(s))) await fire();
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: wrapped, raced: () => fired };
}

// The payer's Confirm landing in the middle of somebody else's write.
export function confirmingBeforeFirstWrite(db: D1Database, billId: string): { db: D1Database; raced: () => boolean } {
  return beforeFirstWrite(db, (real) =>
    real
      .prepare("UPDATE bills SET status = 'confirmed', confirmed_at = '2026-10-28T22:00:00Z' WHERE id = ?")
      .bind(billId)
      .run(),
  );
}
