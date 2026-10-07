import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mountBillingPortal } from "../src/portal.js";
import { createBillingClient } from "../src/client.js";
import { createBilling, createBillingHandler } from "../src/server.js";
import { memoryStorage } from "../src/adapters/memory.js";
import { sandboxProvider, sandboxClock } from "../src/adapters/sandbox.js";
import { price } from "./contract.js";
test("portal loads, changes plans through HTTP and shows admin controls only when requested", async () => {
  const dom = new JSDOM('<main id="root"></main>'),
    element = dom.window.document.querySelector<HTMLElement>("#root")!;
  const clock = sandboxClock(),
    provider = sandboxProvider({ clock: clock.now });
  provider.topUp("customer", 1000000);
  const billing = createBilling({
    namespace: "portal",
    storage: memoryStorage(),
    providers: [provider],
    clock: clock.now,
    prices: [
      price,
      { ...price, id: "business", name: "Business", amount: 100000 },
    ],
  });
  await billing.subscriptions.create({
    id: "sub",
    customerId: "customer",
    priceId: price.id,
    trialDays: 14,
  });
  const handler = createBillingHandler({
    billing,
    authorize: async () => ({ allowed: true, actor: "operator" }),
  });
  const client = createBillingClient({
    baseUrl: "https://example.test/api/billing",
    fetch: async (url, init) => handler(new Request(url, init)),
  });
  let portal = await mountBillingPortal({
    element,
    client,
    subscriptionId: "sub",
  });
  assert.match(element.shadowRoot!.textContent!, /Starter/);
  assert.ok(!element.shadowRoot!.textContent!.includes("Issue account credit"));
  const select =
    element.shadowRoot!.querySelector<HTMLSelectElement>("select")!;
  select.value = "business";
  const update = [...element.shadowRoot!.querySelectorAll("button")].find(
    (b) => b.textContent === "Update plan",
  )!;
  update.click();
  for (
    let i = 0;
    i < 20 && !(await billing.subscriptions.get("sub")).pendingChange;
    i++
  )
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(
    (await billing.subscriptions.get("sub")).pendingChange?.price.id,
    "business",
  );
  await portal.refresh();
  assert.match(element.shadowRoot!.textContent!, /Scheduled plan: Business/);
  portal.destroy();
  portal = await mountBillingPortal({
    element,
    client,
    subscriptionId: "sub",
    admin: true,
  });
  assert.match(element.shadowRoot!.textContent!, /Issue account credit/);
  portal.destroy();
  assert.equal(element.shadowRoot!.childNodes.length, 0);
  dom.window.close();
});
