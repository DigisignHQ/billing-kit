import assert from "node:assert/strict";
import { createBilling, type BillingStorage } from "../src/server.js";
import { sandboxClock, sandboxProvider } from "../src/adapters/sandbox.js";
/** Runs identically against each real database; verifies durable rich state and concurrent reservations. */
export async function advancedContract(storage: BillingStorage) {
  const clock = sandboxClock(),
    provider = sandboxProvider({ clock: clock.now });
  provider.topUp("rich_customer", 1000000);
  const options = {
    namespace: "test",
    storage,
    providers: [provider],
    clock: clock.now,
    prices: [
      {
        id: "rich",
        planId: "rich",
        name: "Rich contract",
        amount: 10000,
        currency: "NGN",
        intervalMonths: 1,
        features: { seats: 2 },
        meters: {
          api: { mode: "metered" as const, included: 2, unitAmount: 10 },
        },
      },
    ],
  };
  const b = createBilling(options);
  await b.subscriptions.create({
    id: "rich_contract",
    customerId: "rich_customer",
    priceId: "rich",
    trialDays: 0,
  });
  await b.credits.issue("rich_contract", {
    operationId: "credit",
    amount: 1000,
    reason: "intro",
    actor: "admin",
  });
  await b.processSubscription("rich_contract");
  await b.usage.record("rich_contract", {
    operationId: "use",
    meter: "api",
    quantity: 5,
  });
  const seats = await Promise.allSettled(
    [0, 1, 2, 3].map((i) =>
      b.entitlements.reserve("rich_contract", {
        operationId: `seat_${i}`,
        feature: "seats",
        quantity: 1,
      }),
    ),
  );
  assert.equal(seats.filter((r) => r.status === "fulfilled").length, 2);
  // Recreate the engine with the same adapter to verify all state survives serialization.
  const resumed = createBilling(options);
  clock.set("2026-02-01");
  await resumed.processSubscription("rich_contract");
  const s = await resumed.subscriptions.get("rich_contract");
  assert.equal(s.charges[0]!.amount, 9000);
  assert.equal(s.charges[1]!.amount, 10030);
  assert.equal(s.capacity.seats, 2);
  await resumed.refunds.create("rich_contract", {
    operationId: "refund",
    chargeId: s.charges[0]!.id,
    amount: 1000,
    reason: "adjustment",
    actor: "admin",
  });
  const exported = JSON.parse(await resumed.admin.export("rich_contract"));
  assert.equal(exported.refunds[0].status, "paid");
  assert.equal(exported.creditEntries.length, 1);
  // Semantically identical input with a different JSON property order must deduplicate.
  await resumed.credits.issue("rich_contract", {
    actor: "admin",
    reason: "intro",
    amount: 1000,
    operationId: "credit",
  });
  assert.equal(
    (await resumed.subscriptions.get("rich_contract")).creditEntries.length,
    1,
  );
}
