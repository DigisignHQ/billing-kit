import { test } from "node:test";
import assert from "node:assert/strict";
import { createBilling, createBillingHandler } from "../src/server.js";
import { memoryStorage, memoryWallet } from "../src/adapters/memory.js";
import { createBillingClient } from "../src/client.js";
import { price } from "./contract.js";
test("browser client and server handler work together through authorized routes", async () => {
  const billing = createBilling({
    storage: memoryStorage(),
    payments: memoryWallet(),
    prices: [price],
    namespace: "http",
  });
  await billing.subscriptions.create({
    id: "sub",
    customerId: "customer",
    priceId: price.id,
  });
  const actions: string[] = [];
  const handle = createBillingHandler({
    billing,
    authorize: async ({ subscriptionId, action }) => {
      actions.push(action);
      return subscriptionId === "sub";
    },
  });
  const client = createBillingClient({
    baseUrl: "https://example.test/api/billing",
    fetch: async (url, init) => handle(new Request(url, init)),
  });
  assert.equal((await client.getSubscription("sub")).customerId, "customer");
  assert.deepEqual(await client.getHistory("sub"), []);
  assert.equal(
    (await client.cancelSubscription("sub")).cancelAtPeriodEnd,
    true,
  );
  assert.deepEqual(actions, ["read", "history", "cancel"]);
  await assert.rejects(() => client.getSubscription("other"), /403/);
});
test("handler requires correct method and denies authorization errors", async () => {
  const billing = createBilling({
    storage: memoryStorage(),
    payments: memoryWallet(),
    prices: [price],
    namespace: "http",
  });
  const handle = createBillingHandler({
    billing,
    authorize: async () => {
      throw new Error("auth service unavailable");
    },
  });
  assert.equal(
    (
      await handle(
        new Request("https://example.test/api/billing/subscriptions/sub"),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handle(
        new Request("https://example.test/api/billing/subscriptions/sub/retry"),
      )
    ).status,
    405,
  );
  assert.equal(
    (await handle(new Request("https://example.test/other"))).status,
    404,
  );
});

test("admin mutation identity comes from authorization, never the request body", async () => {
  const billing = createBilling({
    namespace: "admin",
    storage: memoryStorage(),
    payments: memoryWallet(),
    prices: [price],
  });
  await billing.subscriptions.create({
    id: "sub",
    customerId: "customer",
    priceId: price.id,
  });
  const denied = createBillingHandler({ billing, authorize: async () => true });
  const request = () =>
    new Request("https://example.test/api/billing/subscriptions/sub/credits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "credit",
        amount: 100,
        reason: "support",
        actor: "forged_actor",
      }),
    });
  assert.equal((await denied(request())).status, 403);
  const allowed = createBillingHandler({
    billing,
    authorize: async () => ({ allowed: true, actor: "trusted_operator" }),
  });
  assert.equal((await allowed(request())).status, 200);
  assert.equal(
    (await billing.subscriptions.get("sub")).creditEntries[0]!.actor,
    "trusted_operator",
  );
});
test("malformed and oversized bodies are rejected before mutation", async () => {
  const billing = createBilling({
    namespace: "http",
    storage: memoryStorage(),
    payments: memoryWallet(),
    prices: [price],
  });
  await billing.subscriptions.create({
    id: "sub",
    customerId: "customer",
    priceId: price.id,
  });
  const handler = createBillingHandler({
    billing,
    authorize: async () => true,
    maxBodyBytes: 20,
  });
  for (const body of ["{", "[]", "x".repeat(100)])
    assert.equal(
      (
        await handler(
          new Request(
            "https://example.test/api/billing/subscriptions/sub/change",
            { method: "POST", body },
          ),
        )
      ).status,
      400,
    );
});
