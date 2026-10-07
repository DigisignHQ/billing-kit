import assert from "node:assert/strict";
import {
  createBilling,
  type BillingStorage,
  type PaymentAdapter,
  type Price,
} from "../src/server.js";
import { memoryWallet } from "../src/adapters/memory.js";
export const price: Price = {
  id: "starter_v1",
  planId: "starter",
  name: "Starter",
  amount: 50000,
  currency: "NGN",
  intervalMonths: 1,
  features: { whatsapp: true, offline: false, seats: 3 },
};
export async function storageContract(storage: BillingStorage) {
  let time = new Date("2026-01-31T10:00:00Z");
  const wallet = memoryWallet({ customer: 1_000_000 });
  const billing = createBilling({
    storage,
    payments: wallet,
    namespace: "test",
    prices: [price],
    clock: () => time,
  });
  await billing.subscriptions.create({
    id: "contract",
    customerId: "customer",
    priceId: price.id,
    trialDays: 0,
  });
  await assert.rejects(() =>
    billing.subscriptions.create({
      id: "contract",
      customerId: "customer",
      priceId: price.id,
    }),
  );
  const stale = (await storage.get("contract"))!;
  await Promise.all(
    Array.from({ length: 8 }, () => billing.processSubscription("contract")),
  );
  assert.equal(
    wallet.balance("customer"),
    950000,
    "concurrent workers debit once",
  );
  let s = await billing.subscriptions.get("contract");
  assert.equal(s.charges.length, 1);
  assert.equal(s.charges[0]!.attempts.length, 1);
  assert.equal(s.nextBillingAt, "2026-02-28T10:00:00.000Z");
  stale.version++;
  assert.equal(await storage.compareAndSwap(stale.id, 0, stale), false);
  time = new Date("2026-02-28T10:00:00Z");
  await billing.processSubscription("contract");
  s = await billing.subscriptions.get("contract");
  assert.equal(s.nextBillingAt, "2026-03-31T10:00:00.000Z");
  const snapshot = (await storage.get("contract"))!;
  snapshot.price.amount = 123;
  assert.equal(
    (await storage.get("contract"))!.price.amount,
    50000,
    "reads cannot mutate stored state",
  );
  for (const id of ["A", "a", "z"])
    await billing.subscriptions.create({
      id,
      customerId: "customer",
      priceId: price.id,
    });
  assert.deepEqual(
    (await storage.list(undefined, 2)).map((s) => s.id),
    ["A", "a"],
  );
  assert.deepEqual(
    (await storage.list("a", 2)).map((s) => s.id),
    ["contract", "z"],
  );
  // Simulate a database failure after the wallet commits but before settlement persists.
  let failSettlement = true;
  const interrupted: BillingStorage = {
    create: (s) => storage.create(s),
    get: (id) => storage.get(id),
    list: (after, limit) => storage.list(after, limit),
    async compareAndSwap(id, version, next) {
      if (
        id === "recovery" &&
        next.charges.some((c) => c.status === "paid") &&
        failSettlement
      ) {
        failSettlement = false;
        throw new Error("simulated database interruption");
      }
      return storage.compareAndSwap(id, version, next);
    },
  };
  const recovery = createBilling({
    storage: interrupted,
    payments: wallet,
    namespace: "test",
    prices: [price],
    clock: () => time,
  });
  await recovery.subscriptions.create({
    id: "recovery",
    customerId: "customer",
    priceId: price.id,
    trialDays: 0,
  });
  const before = wallet.balance("customer");
  await assert.rejects(
    () => recovery.processSubscription("recovery"),
    /database interruption/,
  );
  assert.equal(wallet.balance("customer"), before - price.amount);
  await billing.processSubscription("recovery");
  assert.equal(
    wallet.balance("customer"),
    before - price.amount,
    "lost settlement must not debit twice",
  );
  assert.equal((await billing.history("recovery"))[0]!.attempts.length, 1);
  let calls = 0;
  await assert.rejects(() =>
    billing.dispatchEvents("contract", async () => {
      calls++;
      throw new Error("email unavailable");
    }),
  );
  const first = (await billing.subscriptions.get("contract")).events[0]!;
  assert.equal(first.deliveredAt, undefined);
  await billing.dispatchEvents("contract", async () => {
    calls++;
  });
  assert.equal(
    await billing.dispatchEvents("contract", async () => {
      calls++;
    }),
    0,
  );
  assert.ok(calls >= 2);
}
