import { test } from "node:test";
import assert from "node:assert/strict";
import { createBilling } from "../src/server.js";
import { memoryStorage } from "../src/adapters/memory.js";
import { sandboxProvider, sandboxClock } from "../src/adapters/sandbox.js";
import { price } from "./contract.js";
test("24 months of overlapping workers preserve invoice, credit and cash invariants", async () => {
  const clock = sandboxClock("2024-01-31T10:00:00Z"),
    provider = sandboxProvider({ clock: clock.now }),
    initial = 10_000_000;
  provider.topUp("customer", initial);
  const billing = createBilling({
    namespace: "model",
    storage: memoryStorage(),
    providers: [provider],
    clock: clock.now,
    prices: [price],
  });
  await billing.subscriptions.create({
    id: "sub",
    customerId: "customer",
    priceId: price.id,
    trialDays: 0,
  });
  for (let cycle = 0; cycle < 24; cycle++) {
    const before = await billing.subscriptions.get("sub");
    clock.set(before.nextBillingAt);
    if (cycle % 4 === 0)
      await billing.credits.issue("sub", {
        operationId: `credit_${cycle}`,
        amount: 137,
        reason: "test credit",
        actor: "operator",
      });
    if (cycle % 3 === 0) provider.failNext("unknown_after");
    else if (cycle % 3 === 1) provider.failNext("decline");
    await Promise.all(
      Array.from({ length: 6 }, () => billing.processSubscription("sub")),
    );
    await billing.retryPayment("sub");
    const s = await billing.subscriptions.get("sub");
    assert.equal(s.paidCycles, cycle + 1);
    assert.equal(s.charges.length, cycle + 1);
    assert.equal(s.charges.at(-1)!.status, "paid");
    assert.equal(
      s.charges.at(-1)!.attempts.filter((a) => a.status === "paid").length,
      1,
    );
    const paid = s.charges.reduce(
      (total, c) => total + (c.status === "paid" ? c.amount : 0),
      0,
    );
    assert.equal(provider.balance("customer"), initial - paid);
    const credited = s.creditEntries.reduce((n, e) => n + e.amount, 0),
      applied = s.charges.reduce((n, c) => n + c.creditApplied, 0);
    assert.equal(s.creditBalance, credited - applied);
    assert.equal(
      new Set(s.charges.map((c) => c.periodStart)).size,
      s.charges.length,
    );
  }
});
