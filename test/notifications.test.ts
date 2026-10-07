import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBilling,
  createEmailNotifier,
  type BillingEmail,
} from "../src/server.js";
import { memoryStorage } from "../src/adapters/memory.js";
import { sandboxClock, sandboxProvider } from "../src/adapters/sandbox.js";
import { price } from "./contract.js";
test("scheduled email delivery sends trial/reminder/receipt and suppresses recovered failure notices", async () => {
  const clock = sandboxClock(),
    provider = sandboxProvider({ clock: clock.now }),
    b = createBilling({
      namespace: "mail",
      storage: memoryStorage(),
      providers: [provider],
      prices: [price],
      clock: clock.now,
    });
  await b.subscriptions.create({
    id: "sub",
    customerId: "customer",
    priceId: price.id,
    trialDays: 14,
  });
  const sent: BillingEmail[] = [];
  const notify = createEmailNotifier({
    getSubscription: b.subscriptions.get,
    getCustomerEmail: async () => "customer@example.test",
    send: async (email) => {
      sent.push(email);
    },
    clock: clock.now,
  });
  await b.runScheduledSweep(notify);
  assert.match(sent[0]!.subject, /trial/);
  clock.advance(11);
  await b.runScheduledSweep(notify);
  assert.match(sent.at(-1)!.subject, /renewal/);
  clock.advance(3);
  await b.processSubscription("sub");
  provider.topUp("customer", 100000);
  await b.retryPayment("sub");
  await b.runScheduledSweep(notify);
  assert.match(sent.at(-1)!.subject, /receipt/);
  assert.equal(
    sent.filter((e) => e.subject.includes("payment needed")).length,
    0,
  );
  const count = sent.length;
  await b.runScheduledSweep(notify);
  assert.equal(sent.length, count);
});
test("complete sweep continues other subscriptions after a delivery failure and retries durable outbox", async () => {
  const clock = sandboxClock(),
    provider = sandboxProvider({ clock: clock.now }),
    b = createBilling({
      namespace: "mail",
      storage: memoryStorage(),
      providers: [provider],
      prices: [price],
      clock: clock.now,
    });
  for (const id of ["a", "b"])
    await b.subscriptions.create({
      id,
      customerId: "customer",
      priceId: price.id,
    });
  const delivered: string[] = [];
  await assert.rejects(
    () =>
      b.runScheduledSweep(async (e) => {
        if (e.subscriptionId === "a") throw new Error("offline");
        delivered.push(e.subscriptionId);
      }),
    AggregateError,
  );
  assert.deepEqual(delivered, ["b"]);
  assert.equal(
    (await b.subscriptions.get("a")).events[0]!.deliveredAt,
    undefined,
  );
  assert.equal((await b.runScheduledSweep(async () => {})).delivered, 1);
});
