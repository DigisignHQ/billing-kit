import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
for (const load of [
  (name) => import(name),
  (name) => Promise.resolve(require(name)),
]) {
  const { createBilling } = await load("@digisign/billing-kit/server");
  const { memoryStorage, memoryWallet } = await load(
    "@digisign/billing-kit/adapters/memory",
  );
  const { createBillingClient } = await load("@digisign/billing-kit/client");
  const { mountBillingPortal } = await load("@digisign/billing-kit/portal");
  assert.equal(typeof createBillingClient, "function");
  assert.equal(typeof mountBillingPortal, "function");
  const billing = createBilling({
    namespace: "package",
    storage: memoryStorage(),
    payments: memoryWallet({ customer: 100 }),
    prices: [
      {
        id: "plan",
        planId: "plan",
        name: "Plan",
        amount: 100,
        currency: "NGN",
        intervalMonths: 1,
        features: {},
      },
    ],
  });
  await billing.subscriptions.create({
    id: "sub",
    customerId: "customer",
    priceId: "plan",
    trialDays: 0,
  });
  await billing.processSubscription("sub");
  assert.equal((await billing.subscriptions.get("sub")).status, "active");
}
console.log("ESM and CommonJS package exports passed.");
