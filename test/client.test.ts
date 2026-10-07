import { test } from "node:test";
import assert from "node:assert/strict";
import { createBillingClient } from "../src/client.js";
test("client encodes IDs and uses POST for billing actions", async () => {
  const requests: { url: string; method: string | undefined }[] = [];
  const client = createBillingClient({
    baseUrl: "/api/billing/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), method: init?.method });
      return new Response(JSON.stringify({ id: "sub" }));
    },
  });
  await client.getSubscription("a/b");
  await client.retryPayment("sub");
  assert.deepEqual(requests, [
    { url: "/api/billing/subscriptions/a%2Fb", method: "GET" },
    { url: "/api/billing/subscriptions/sub/retry", method: "POST" },
  ]);
});
test("client rejects failed requests without exposing server response bodies", async () => {
  const client = createBillingClient({
    baseUrl: "/billing",
    fetch: async () => new Response("private", { status: 403 }),
  });
  await assert.rejects(() => client.getHistory("sub"), /403/);
});
