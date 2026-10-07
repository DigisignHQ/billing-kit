import type { Pool } from "pg";
import type { BillingStorage, Subscription } from "../types.js";
/** Pass a pool with a dedicated database/schema search_path. Call migrate() explicitly. */
export function postgresStorage(
  pool: Pool,
): BillingStorage & { migrate(): Promise<void> } {
  return {
    async migrate() {
      await pool.query(`CREATE TABLE IF NOT EXISTS billing_kit_subscriptions (
      id text COLLATE "C" PRIMARY KEY, version integer NOT NULL, state jsonb NOT NULL)`);
    },
    async create(s) {
      const r = await pool.query(
        "INSERT INTO billing_kit_subscriptions (id,version,state) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [s.id, s.version, JSON.stringify(s)],
      );
      return r.rowCount === 1;
    },
    async get(id) {
      const r = await pool.query<{ state: Subscription }>(
        "SELECT state FROM billing_kit_subscriptions WHERE id=$1",
        [id],
      );
      return r.rows[0]?.state ?? null;
    },
    async compareAndSwap(id, version, next) {
      if (next.id !== id || next.version !== version + 1)
        throw new Error("Invalid state version");
      const r = await pool.query(
        "UPDATE billing_kit_subscriptions SET version=$3,state=$4 WHERE id=$1 AND version=$2",
        [id, version, next.version, JSON.stringify(next)],
      );
      return r.rowCount === 1;
    },
    async list(after, limit = 100) {
      const r = await pool.query<{ state: Subscription }>(
        'SELECT state FROM billing_kit_subscriptions WHERE ($1::text IS NULL OR id > $1 COLLATE "C") ORDER BY id LIMIT $2',
        [after ?? null, limit],
      );
      return r.rows.map((row) => row.state);
    },
  };
}
