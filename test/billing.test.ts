import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBilling,
  addMonths,
  type PaymentAdapter,
} from "../src/server.js";
import { memoryStorage, memoryWallet } from "../src/adapters/memory.js";
import { price, storageContract } from "./contract.js";
function setup(balance = 100000, payment?: PaymentAdapter) {
  let time = new Date("2026-01-01T00:00:00Z");
  const storage = memoryStorage(),
    wallet = memoryWallet({ customer: balance });
  const billing = createBilling({
    storage,
    payments: payment ?? wallet,
    namespace: "test",
    prices: [price],
    clock: () => time,
  });
  return {
    billing,
    wallet,
    storage,
    setTime: (s: string) => {
      time = new Date(s);
    },
    create: (trialDays = 14) =>
      billing.subscriptions.create({
        id: "sub",
        customerId: "customer",
        priceId: price.id,
        trialDays,
      }),
  };
}
test("memory adapter satisfies shared contract", () =>
  storageContract(memoryStorage()));
test("trial reminders happen even with funds and deduplicate on repeat scans", async () => {
  const f = setup();
  await f.create();
  await f.billing.processDueRenewals();
  assert.equal(f.wallet.balance("customer"), 100000);
  f.setTime("2026-01-12T00:00:00Z");
  await f.billing.processDueRenewals();
  await f.billing.processDueRenewals();
  const s = await f.billing.subscriptions.get("sub");
  assert.equal(s.events.filter((e) => e.type === "renewal.reminder").length, 1);
  assert.equal(s.charges.length, 0);
  f.setTime("2026-01-15T00:00:00Z");
  await f.billing.processDueRenewals();
  assert.equal(f.wallet.balance("customer"), 50000);
});
test("insufficient funds: daily retries, fixed grace, suspension, top-up recovery", async () => {
  const f = setup(0);
  await f.create(0);
  await f.billing.processDueRenewals();
  let s = await f.billing.subscriptions.get("sub");
  assert.equal(s.status, "past_due");
  await f.billing.processDueRenewals();
  assert.equal((await f.billing.history("sub"))[0]!.attempts.length, 1);
  f.setTime("2026-01-02T00:00:00Z");
  await f.billing.processDueRenewals();
  assert.equal((await f.billing.history("sub"))[0]!.attempts.length, 2);
  f.setTime("2026-01-06T00:00:00Z");
  await f.billing.processDueRenewals();
  assert.equal((await f.billing.subscriptions.get("sub")).status, "suspended");
  assert.equal(
    (
      await f.billing.entitlements.check({
        subscriptionId: "sub",
        feature: "whatsapp",
      })
    ).allowed,
    false,
  );
  f.wallet.topUp("customer", 50000);
  await f.billing.retryPayment("sub");
  s = await f.billing.subscriptions.get("sub");
  assert.equal(s.status, "active");
  assert.equal(f.wallet.balance("customer"), 0);
  assert.equal(s.charges[0]!.attempts.length, 3);
});
test("successful debit followed by lost response reconciles same key after engine restart", async () => {
  const wallet = memoryWallet({ customer: 100000 });
  let crash = true;
  const keys: string[] = [];
  const payment: PaymentAdapter = {
    async debit(r) {
      keys.push(r.idempotencyKey);
      const result = await wallet.debit(r);
      if (crash) {
        crash = false;
        throw new Error("response lost");
      }
      return result;
    },
  };
  const f = setup(0, payment);
  await f.create(0);
  await f.billing.processDueRenewals();
  assert.equal(wallet.balance("customer"), 50000);
  assert.equal(
    (await f.billing.history("sub"))[0]!.attempts[0]!.status,
    "pending",
  );
  const restarted = createBilling({
    storage: f.storage,
    payments: payment,
    namespace: "test",
    prices: [price],
    clock: () => new Date("2026-01-02"),
  });
  await restarted.processDueRenewals();
  assert.equal(wallet.balance("customer"), 50000);
  assert.equal(keys[0], keys[1]);
  assert.equal((await restarted.subscriptions.get("sub")).status, "active");
});
test("stale failure cannot overwrite concurrent successful settlement", async () => {
  const wallet = memoryWallet({ customer: 100000 });
  let count = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const payment: PaymentAdapter = {
    async debit(r) {
      if (++count === 1) {
        await gate;
        return { status: "unknown", reason: "late timeout" };
      }
      return wallet.debit(r);
    },
  };
  const f = setup(0, payment);
  await f.create(0);
  const first = f.billing.processSubscription("sub");
  while (count === 0) await new Promise((r) => setImmediate(r));
  await f.billing.processSubscription("sub");
  release();
  await first;
  assert.equal((await f.billing.history("sub"))[0]!.status, "paid");
  assert.equal(wallet.balance("customer"), 50000);
});
test("feature checks fail closed when scheduler has not suspended an overdue account", async () => {
  const f = setup();
  await f.create(0);
  await f.billing.processDueRenewals();
  assert.equal(
    (
      await f.billing.entitlements.check({
        subscriptionId: "sub",
        feature: "seats",
        currentUsage: 2,
      })
    ).allowed,
    true,
  );
  assert.equal(
    (
      await f.billing.entitlements.check({
        subscriptionId: "sub",
        feature: "seats",
        currentUsage: 3,
      })
    ).allowed,
    false,
  );
  assert.equal(
    (
      await f.billing.entitlements.check({
        subscriptionId: "sub",
        feature: "offline",
      })
    ).allowed,
    false,
  );
  assert.equal(
    (
      await f.billing.entitlements.check({
        subscriptionId: "sub",
        feature: "toString",
      })
    ).allowed,
    false,
  );
  f.setTime("2026-02-06T00:00:00Z");
  assert.equal(
    (
      await f.billing.entitlements.check({
        subscriptionId: "sub",
        feature: "whatsapp",
      })
    ).allowed,
    false,
  );
});
test("cancellation stops renewal and access at period end", async () => {
  const f = setup();
  await f.create(0);
  await f.billing.processDueRenewals();
  await f.billing.subscriptions.cancel("sub");
  f.setTime("2026-02-01T00:00:00Z");
  assert.equal(
    (
      await f.billing.entitlements.check({
        subscriptionId: "sub",
        feature: "whatsapp",
      })
    ).allowed,
    false,
  );
  await f.billing.processDueRenewals();
  assert.equal((await f.billing.subscriptions.get("sub")).status, "cancelled");
  assert.equal(f.wallet.balance("customer"), 50000);
});
test("pending or failed charges must be resolved before cancellation", async () => {
  const f = setup(0);
  await f.create(0);
  await f.billing.processDueRenewals();
  await assert.rejects(() => f.billing.subscriptions.cancel("sub"));
});
test("prices are snapshotted and trial transition can last 30 days", async () => {
  const f = setup();
  const s = await f.create(30);
  assert.equal(s.nextBillingAt, "2026-01-31T00:00:00.000Z");
  s.price.amount = 1;
  assert.equal((await f.billing.subscriptions.get("sub")).price.amount, 50000);
});
test("monthly, quarterly and annual dates retain original calendar anchor", () => {
  assert.equal(
    addMonths("2024-02-29T12:30:00Z", 12, 29),
    "2025-02-28T12:30:00.000Z",
  );
  assert.equal(
    addMonths("2026-01-31T12:30:00Z", 3, 31),
    "2026-04-30T12:30:00.000Z",
  );
});
test("invalid monetary values, duplicate prices and unsupported currency are rejected", () => {
  const base = {
    storage: memoryStorage(),
    payments: memoryWallet(),
    namespace: "test",
  };
  for (const amount of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() =>
      createBilling({ ...base, prices: [{ ...price, amount }] }),
    );
  assert.throws(() => createBilling({ ...base, prices: [price, price] }));
  assert.throws(() =>
    createBilling({
      ...base,
      prices: [{ ...price, currency: "ZZZ" }],
    }),
  );
});
test("pagination visits every customer and isolates per-subscription failures", async () => {
  const f = setup();
  await f.create();
  await f.billing.subscriptions.create({
    id: "two",
    customerId: "customer",
    priceId: price.id,
  });
  const first = await f.billing.processDueRenewals({ limit: 1 });
  assert.equal(first.results[0]!.id, "sub");
  const second = await f.billing.processDueRenewals({
    after: first.nextCursor,
    limit: 1,
  });
  assert.equal(second.results[0]!.id, "two");
});
test("zero-day grace still attempts first payment", async () => {
  const storage = memoryStorage(),
    wallet = memoryWallet({ customer: 50000 });
  const b = createBilling({
    storage,
    payments: wallet,
    namespace: "zero",
    prices: [price],
    graceDays: 0,
  });
  await b.subscriptions.create({
    id: "sub",
    customerId: "customer",
    priceId: price.id,
    trialDays: 0,
  });
  await b.processSubscription("sub");
  assert.equal((await b.subscriptions.get("sub")).status, "active");
});

test("suspension reminders include the deadline and are deduplicated", async () => {
  const f = setup(0);
  await f.create(0);
  await f.billing.processDueRenewals();
  f.setTime("2026-01-03T00:00:00Z");
  await f.billing.processDueRenewals();
  await f.billing.processDueRenewals();
  const reminders = (await f.billing.subscriptions.get("sub")).events.filter(
    (e) => e.type === "payment.reminder",
  );
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0]!.data.graceEndsAt, "2026-01-06T00:00:00.000Z");
});

test("first collection is not deferred when the clock advances while creating the invoice", async () => {
  let tick = Date.parse("2026-01-01T00:00:00Z");
  const wallet = memoryWallet({ customer: 100000 });
  const b = createBilling({
    namespace: "clock",
    storage: memoryStorage(),
    payments: wallet,
    prices: [price],
    clock: () => new Date(tick++),
  });
  await b.subscriptions.create({
    id: "sub",
    customerId: "customer",
    priceId: price.id,
    trialDays: 0,
  });
  await b.processSubscription("sub");
  assert.equal((await b.subscriptions.get("sub")).status, "active");
  assert.equal(wallet.balance("customer"), 50000);
});
