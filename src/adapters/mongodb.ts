import type { Db } from "mongodb";
import type { BillingStorage, Subscription } from "../types.js";
/** Dedicated collection; each subscription is an atomic aggregate. Majority writes are required. */
export function mongoStorage(db: Db): BillingStorage {
  const collection = db.collection<{
    _id: string;
    version: number;
    state: Subscription;
  }>("billing_kit_subscriptions", {
    writeConcern: { w: "majority" },
    readConcern: { level: "majority" },
    readPreference: "primary",
  });
  return {
    async create(s) {
      try {
        await collection.insertOne({ _id: s.id, version: s.version, state: s });
        return true;
      } catch (error) {
        if ((error as { code?: number }).code === 11000) return false;
        throw error;
      }
    },
    async get(id) {
      return (await collection.findOne({ _id: id }))?.state ?? null;
    },
    async compareAndSwap(id, version, next) {
      if (next.id !== id || next.version !== version + 1)
        throw new Error("Invalid state version");
      const r = await collection.replaceOne(
        { _id: id, version },
        { version: next.version, state: next },
      );
      return r.modifiedCount === 1;
    },
    async list(after, limit = 100) {
      const rows = await collection
        .find(after === undefined ? {} : { _id: { $gt: after } })
        .collation({ locale: "simple" })
        .sort({ _id: 1 })
        .limit(limit)
        .toArray();
      return rows.map((row) => row.state);
    },
  };
}
