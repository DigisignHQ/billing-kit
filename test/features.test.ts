import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBilling,
  createProviderWebhookHandler,
  renderInvoice,
  createWebhookDelivery,
  signWebhook,
  verifyWebhookSignature,
} from "../src/server.js";
import { memoryStorage } from "../src/adapters/memory.js";
import { sandboxClock, sandboxProvider } from "../src/adapters/sandbox.js";
import type { Price, BillingOptions } from "../src/types.js";
const basic: Price = {
  id: "basic",
  planId: "basic",
  name: "Basic",
  amount: 10000,
  currency: "NGN",
  intervalMonths: 1,
  features: { sign: true, seats: 2 },
};
const pro: Price = {
  ...basic,
  id: "pro",
  planId: "pro",
  name: "Pro",
  amount: 20000,
  features: { sign: true, seats: 5, sso: true },
};
const addon: Price = {
  ...basic,
  id: "extra",
  planId: "extra",
  name: "Extra",
  amount: 1000,
  features: { whatsapp: true, seats: 1 },
};
function setup(
  extra: Partial<BillingOptions> = {},
  mode: "automatic" | "links" = "automatic",
) {
  const clock = sandboxClock(),
    provider = sandboxProvider({ clock: clock.now, mode });
  provider.topUp("customer", 1_000_000);
  const b = createBilling({
    namespace: "test",
    storage: memoryStorage(),
    providers: [provider],
    prices: [basic, pro, addon],
    clock: clock.now,
    ...extra,
  });
  const create = (
    data: Partial<Parameters<typeof b.subscriptions.create>[0]> = {},
  ) =>
    b.subscriptions.create({
      id: "sub",
      customerId: "customer",
      priceId: "basic",
      trialDays: 0,
      ...data,
    });
  return { b, clock, provider, create };
}
test("custom daily, weekly, quarterly and annual schedules use calendar boundaries", async () => {
  for (const [unit, count, end] of [
    ["day", 10, "2026-01-11"],
    ["week", 2, "2026-01-15"],
    ["month", 3, "2026-04-01"],
    ["year", 1, "2027-01-01"],
  ] as const) {
    const p = {
        ...basic,
        intervalMonths: undefined,
        interval: { unit, count },
      },
      f = setup({ prices: [p] });
    await f.create();
    await f.b.processSubscription("sub");
    assert.equal(
      (await f.b.subscriptions.get("sub")).nextBillingAt,
      `${end}T00:00:00.000Z`,
    );
  }
});
test("custom first billing date and currency precision are explicit", async () => {
  const f = setup({ prices: [{ ...basic, currency: "JPY" }] });
  f.provider.topUp("customer", 20000, "JPY");
  await f.create({ firstBillingAt: "2026-01-10T12:00:00Z" });
  f.clock.set("2026-01-10T12:00:00Z");
  await f.b.processSubscription("sub");
  assert.equal(f.provider.balance("customer", "JPY"), 10000);
  assert.equal(f.b.catalog().currencies.JPY, 0);
  const s = await f.b.subscriptions.get("sub");
  assert.match(
    renderInvoice({ subscription: s, invoice: s.charges[0]! }),
    /JPY 10000/,
  );
});
test("plan quantities and addons determine recurring amount and entitlements", async () => {
  const f = setup();
  await f.create({ quantity: 2, addons: [{ priceId: "extra", quantity: 3 }] });
  await f.b.processSubscription("sub");
  assert.equal((await f.b.history("sub"))[0]!.amount, 23000);
  assert.equal(
    (await f.b.entitlements.check({ subscriptionId: "sub", feature: "seats" }))
      .limit,
    7,
  );
  assert.equal(
    (
      await f.b.entitlements.check({
        subscriptionId: "sub",
        feature: "whatsapp",
      })
    ).allowed,
    true,
  );
});
test("coupons expire after configured paid cycles and credits apply once", async () => {
  const f = setup({
    coupons: [{ id: "welcome", percentBps: 2500, cycles: 1 }],
  });
  await f.create({ couponId: "welcome" });
  const credit = {
    operationId: "grant",
    amount: 2000,
    reason: "Migration credit",
    actor: "admin",
  };
  await f.b.credits.issue("sub", credit);
  await f.b.credits.issue("sub", credit);
  await f.b.processSubscription("sub");
  let s = await f.b.subscriptions.get("sub");
  assert.equal(s.charges[0]!.amount, 5500);
  assert.equal(s.charges[0]!.discount, 2500);
  assert.equal(s.creditBalance, 0);
  f.clock.set("2026-02-01");
  await f.b.processSubscription("sub");
  s = await f.b.subscriptions.get("sub");
  assert.equal(s.charges[1]!.amount, 10000);
  await assert.rejects(
    () => f.b.credits.issue("sub", { ...credit, amount: 1000 }),
    /reused/,
  );
});
test("coupon validation rejects wrong currency, expired code and excessive discount", async () => {
  const f = setup({
    coupons: [
      { id: "usd", amount: 100, currency: "USD" },
      { id: "old", percentBps: 1000, expiresAt: "2025-01-01" },
    ],
  });
  await assert.rejects(() => f.create({ couponId: "usd" }));
  await assert.rejects(() => f.create({ couponId: "old" }));
  assert.throws(() => setup({ coupons: [{ id: "bad", percentBps: 10001 }] }));
});
test("immediate upgrade is prorated and grants features only after successful collection", async () => {
  const f = setup();
  await f.create();
  await f.b.processSubscription("sub");
  f.clock.set("2026-01-16T12:00:00Z");
  f.provider.failNext("decline");
  await f.b.subscriptions.change("sub", {
    operationId: "upgrade",
    priceId: "pro",
    effective: "immediate",
  });
  let s = await f.b.subscriptions.get("sub");
  assert.equal(s.price.id, "basic");
  assert.equal(s.charges[1]!.amount, 5000);
  await f.b.retryPayment("sub");
  s = await f.b.subscriptions.get("sub");
  assert.equal(s.price.id, "pro");
  assert.equal(s.nextBillingAt, "2026-02-01T00:00:00.000Z");
  await f.b.subscriptions.change("sub", {
    operationId: "downgrade",
    priceId: "basic",
    effective: "immediate",
  });
  s = await f.b.subscriptions.get("sub");
  assert.equal(s.price.id, "basic");
  assert.equal(s.creditBalance, 5000);
});
test("scheduled plan and interval changes take effect only at the next paid renewal", async () => {
  const quarterly: Price = {
    ...pro,
    id: "quarterly",
    intervalMonths: 3,
    amount: 50000,
  };
  const f = setup({ prices: [basic, quarterly] });
  await f.create();
  await f.b.processSubscription("sub");
  await f.b.subscriptions.change("sub", {
    operationId: "change",
    priceId: "quarterly",
  });
  assert.equal((await f.b.subscriptions.get("sub")).price.id, "basic");
  f.clock.set("2026-02-01");
  await f.b.processSubscription("sub");
  const s = await f.b.subscriptions.get("sub");
  assert.equal(s.price.id, "quarterly");
  assert.equal(s.nextBillingAt, "2026-05-01T00:00:00.000Z");
});
test("pause immediately freezes paid time and resume shifts next boundary", async () => {
  const f = setup();
  await f.create();
  await f.b.processSubscription("sub");
  f.clock.advance(10);
  await f.b.subscriptions.pause("sub", {
    operationId: "pause",
    immediate: true,
  });
  assert.equal(
    (await f.b.entitlements.check({ subscriptionId: "sub", feature: "sign" }))
      .allowed,
    false,
  );
  f.clock.advance(5);
  await f.b.processSubscription("sub");
  assert.equal((await f.b.history("sub")).length, 1);
  await f.b.subscriptions.resume("sub", "resume");
  assert.equal(
    (await f.b.subscriptions.get("sub")).nextBillingAt,
    "2026-02-06T00:00:00.000Z",
  );
});
test("boundary pause and cancelled subscription reactivation do not reuse paid invoices", async () => {
  const f = setup();
  await f.create();
  await f.b.processSubscription("sub");
  await f.b.subscriptions.pause("sub", { operationId: "pause" });
  f.clock.set("2026-02-01");
  await f.b.processSubscription("sub");
  assert.equal((await f.b.subscriptions.get("sub")).status, "paused");
  f.clock.advance(2);
  await f.b.subscriptions.resume("sub", "resume");
  await f.b.processSubscription("sub");
  await f.b.subscriptions.cancel("sub", {
    immediate: true,
    operationId: "cancel",
  });
  await f.b.subscriptions.reactivate("sub", "reactivate");
  await f.b.processSubscription("sub");
  const s = await f.b.subscriptions.get("sub");
  assert.equal(s.status, "active");
  assert.equal(new Set(s.charges.map((c) => c.id)).size, 3);
});
test("atomic seat reservations prevent concurrent oversubscription", async () => {
  const f = setup();
  await f.create({ trialDays: 14 });
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) =>
      f.b.entitlements.reserve("sub", {
        operationId: `seat${i}`,
        feature: "seats",
        quantity: 1,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  await f.b.entitlements.release("sub", {
    operationId: "release",
    feature: "seats",
    quantity: 1,
  });
  assert.equal(
    (await f.b.entitlements.check({ subscriptionId: "sub", feature: "seats" }))
      .allowed,
    true,
  );
});
test("metered overages settle in arrears and usage events deduplicate", async () => {
  const f = setup({
    prices: [
      {
        ...basic,
        meters: { checks: { mode: "metered", included: 10, unitAmount: 25 } },
      },
    ],
  });
  await f.create();
  await f.b.processSubscription("sub");
  const usage = { operationId: "request1", meter: "checks", quantity: 15 };
  await f.b.usage.record("sub", usage);
  await f.b.usage.record("sub", usage);
  assert.equal((await f.b.usage.balance("sub", "checks")).used, 15);
  f.clock.set("2026-02-01");
  await f.b.processSubscription("sub");
  const s = await f.b.subscriptions.get("sub");
  assert.equal(s.charges[1]!.amount, 10125);
  assert.equal(s.charges[1]!.lines[1]!.amount, 125);
  assert.equal((await f.b.usage.balance("sub", "checks")).used, 0);
});
test("cancellation collects final usage without renewing the subscription", async () => {
  const f = setup({
    prices: [
      {
        ...basic,
        meters: { checks: { mode: "metered", included: 0, unitAmount: 25 } },
      },
    ],
  });
  await f.create();
  await f.b.processSubscription("sub");
  await f.b.usage.record("sub", {
    operationId: "request",
    meter: "checks",
    quantity: 4,
  });
  await f.b.subscriptions.cancel("sub");
  f.clock.set("2026-02-01");
  await f.b.processSubscription("sub");
  const s = await f.b.subscriptions.get("sub");
  assert.equal(s.status, "cancelled");
  assert.equal(s.charges[1]!.amount, 100);
  assert.equal(s.charges[1]!.kind, "usage");
});
test("prepaid purchases grant units after payment and consumption cannot exceed balance", async () => {
  const f = setup({
    prices: [
      {
        ...basic,
        meters: { checks: { mode: "prepaid", included: 2, unitAmount: 25 } },
      },
    ],
  });
  await f.create();
  await f.b.processSubscription("sub");
  await f.b.usage.buy("sub", {
    operationId: "purchase",
    meter: "checks",
    quantity: 10,
  });
  await f.b.usage.record("sub", {
    operationId: "consume",
    meter: "checks",
    quantity: 12,
  });
  assert.equal((await f.b.usage.balance("sub", "checks")).remaining, 0);
  await assert.rejects(() =>
    f.b.usage.record("sub", {
      operationId: "over",
      meter: "checks",
      quantity: 1,
    }),
  );
  f.clock.set("2026-02-01");
  await f.b.processSubscription("sub");
  assert.equal((await f.b.usage.balance("sub", "checks")).remaining, 2);
});
test("refunds are idempotent and concurrent refunds cannot exceed the collected amount", async () => {
  const f = setup();
  await f.create();
  await f.b.processSubscription("sub");
  const charge = (await f.b.history("sub"))[0]!;
  const input = {
    operationId: "refund",
    chargeId: charge.id,
    amount: 6000,
    reason: "Service credit",
    actor: "operator",
  };
  await f.b.refunds.create("sub", input);
  await f.b.refunds.create("sub", input);
  assert.equal(f.provider.balance("customer"), 996000);
  const results = await Promise.allSettled(
    [1, 2].map((i) =>
      f.b.refunds.create("sub", {
        ...input,
        operationId: `refund${i}`,
        amount: 3000,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.provider.balance("customer"), 999000);
});
test("void restores reserved account credit and cannot discard an unknown collection", async () => {
  const f = setup();
  await f.create();
  await f.b.credits.issue("sub", {
    operationId: "credit",
    amount: 2000,
    reason: "credit",
    actor: "admin",
  });
  f.provider.failNext("decline");
  await f.b.processSubscription("sub");
  const c = (await f.b.history("sub"))[0]!;
  await f.b.invoices.void("sub", {
    chargeId: c.id,
    operationId: "void",
    reason: "cancel contract",
    actor: "admin",
  });
  assert.equal((await f.b.subscriptions.get("sub")).creditBalance, 2000);
  const g = setup();
  await g.create();
  g.provider.failNext("unknown_after");
  await g.b.processSubscription("sub");
  const unresolved = (await g.b.history("sub"))[0]!;
  await assert.rejects(() =>
    g.b.invoices.void("sub", {
      chargeId: unresolved.id,
      operationId: "void",
      reason: "cancel",
      actor: "admin",
    }),
  );
});
test("payment links await confirmation and signed webhooks settle exactly once", async () => {
  const f = setup({}, "links");
  await f.create();
  await f.b.processSubscription("sub");
  let s = await f.b.subscriptions.get("sub");
  const attempt = s.charges[0]!.attempts[0]!;
  assert.equal(attempt.status, "requires_action");
  assert.equal(s.charges[0]!.status, "pending");
  f.provider.completePayment(attempt.key);
  const webhook = f.provider.webhook(attempt.key);
  await f.b.handleWebhook("sandbox", webhook);
  await f.b.handleWebhook("sandbox", webhook);
  s = await f.b.subscriptions.get("sub");
  assert.equal(s.charges[0]!.status, "paid");
  assert.equal(s.webhookIds.length, 1);
  assert.equal(s.paidCycles, 1);
});
test("invalid signatures, mismatched amounts and stale webhooks are rejected", async () => {
  const f = setup({}, "links");
  await f.create();
  await f.b.processSubscription("sub");
  const a = (await f.b.history("sub"))[0]!.attempts[0]!;
  f.provider.completePayment(a.key);
  const w = f.provider.webhook(a.key);
  await assert.rejects(() =>
    f.b.handleWebhook("sandbox", { ...w, rawBody: w.rawBody + " " }),
  );
  const altered = JSON.parse(w.rawBody);
  altered.amount += 1;
  altered.id = "altered_amount";
  const rawBody = JSON.stringify(altered),
    timestamp = w.headers.get("x-billing-timestamp")!;
  const headers = new Headers(w.headers);
  headers.set(
    "x-billing-signature",
    signWebhook(rawBody, "local-sandbox-secret", timestamp),
  );
  await assert.rejects(
    () => f.b.handleWebhook("sandbox", { rawBody, headers }),
    /does not match/,
  );
  f.clock.advance(1);
  await assert.rejects(() => f.b.handleWebhook("sandbox", w));
  const handler = createProviderWebhookHandler(f.b, "sandbox");
  assert.equal(
    (
      await handler(
        new Request("https://app.test/hook", {
          method: "POST",
          body: w.rawBody,
          headers: w.headers,
        }),
      )
    ).status,
    400,
  );
});
test("unknown-before and unknown-after outcomes recover via original attempt", async () => {
  for (const fault of ["unknown_before", "unknown_after"] as const) {
    const f = setup();
    await f.create();
    f.provider.failNext(fault);
    await f.b.processSubscription("sub");
    await f.b.processSubscription("sub");
    assert.equal(f.provider.balance("customer"), 990000);
    assert.equal((await f.b.history("sub"))[0]!.attempts.length, 1);
  }
});
test("payment method tokens must belong to the customer and provider can change after a decline", async () => {
  const f = setup();
  await f.create();
  const foreign = f.provider.registerPaymentMethod("other");
  await assert.rejects(() =>
    f.b.paymentMethods.set("sub", {
      operationId: "foreign",
      providerId: "sandbox",
      token: foreign,
    }),
  );
  const own = f.provider.registerPaymentMethod("customer");
  await f.b.paymentMethods.set("sub", {
    operationId: "own",
    providerId: "sandbox",
    token: own,
  });
  assert.equal((await f.b.subscriptions.get("sub")).paymentMethod?.id, own);
});
test("printable invoices escape data and receipts require settlement", async () => {
  const f = setup({
    prices: [{ ...basic, name: "<script>alert(1)</script>" }],
  });
  await f.create();
  f.provider.failNext("decline");
  await f.b.processSubscription("sub");
  let s = await f.b.subscriptions.get("sub");
  assert.throws(() =>
    renderInvoice({ subscription: s, invoice: s.charges[0]!, receipt: true }),
  );
  await f.b.retryPayment("sub");
  s = await f.b.subscriptions.get("sub");
  const html = renderInvoice({
    subscription: s,
    invoice: s.charges[0]!,
    receipt: true,
  });
  assert.ok(!html.includes("<script>"));
  assert.match(html, /Receipt/);
});
test("outbound webhooks are signed and delivery failures remain retryable", async () => {
  const f = setup();
  await f.create();
  let count = 0;
  const deliver = createWebhookDelivery({
    url: "https://example.test/events",
    secret: "secret",
    clock: f.clock.now,
    fetch: async (_url, init) => {
      verifyWebhookSignature({
        rawBody: init!.body as string,
        headers: new Headers(init!.headers),
        secret: "secret",
        now: f.clock.now(),
      });
      return new Response(null, { status: ++count === 1 ? 500 : 204 });
    },
  });
  await assert.rejects(() => f.b.dispatchEvents("sub", deliver));
  assert.equal(await f.b.dispatchEvents("sub", deliver), 1);
});
test("namespace isolation prevents cross-environment access to shared storage", async () => {
  const storage = memoryStorage(),
    f = setup({ storage });
  await f.create();
  const other = setup({ storage, namespace: "other" });
  await assert.rejects(() => other.b.subscriptions.get("sub"), /namespace/);
});

test("pausing preserves usage allowance and cancelling a paused subscription completes", async () => {
  const f = setup({
    prices: [
      {
        ...basic,
        meters: { checks: { mode: "prepaid", included: 10, unitAmount: 5 } },
      },
    ],
  });
  await f.create();
  await f.b.processSubscription("sub");
  await f.b.usage.record("sub", {
    operationId: "consume",
    meter: "checks",
    quantity: 4,
  });
  f.clock.advance(5);
  await f.b.subscriptions.pause("sub", {
    operationId: "pause",
    immediate: true,
  });
  f.clock.advance(5);
  await f.b.subscriptions.resume("sub", "resume");
  assert.equal((await f.b.usage.balance("sub", "checks")).used, 4);
  await f.b.subscriptions.pause("sub", {
    operationId: "pause2",
    immediate: true,
  });
  await f.b.subscriptions.cancel("sub");
  assert.equal((await f.b.subscriptions.get("sub")).status, "cancelled");
});
test("prepaid purchase replay cannot cause an unrelated future renewal", async () => {
  const f = setup({
    prices: [
      {
        ...basic,
        meters: { checks: { mode: "prepaid", included: 0, unitAmount: 5 } },
      },
    ],
  });
  await f.create();
  await f.b.processSubscription("sub");
  const input = { operationId: "buy", meter: "checks", quantity: 5 };
  await f.b.usage.buy("sub", input);
  f.clock.set("2026-02-01");
  await f.b.usage.buy("sub", input);
  assert.equal((await f.b.history("sub")).length, 2);
});
test("unknown capacity and meter names fail safely", async () => {
  const f = setup();
  await f.create({ trialDays: 14 });
  await assert.rejects(() =>
    f.b.entitlements.release("sub", {
      operationId: "release",
      feature: "toString",
      quantity: 1,
    }),
  );
  await assert.rejects(() => f.b.usage.balance("sub", "toString"));
  assert.deepEqual((await f.b.subscriptions.get("sub")).capacity, {});
});
test("malformed lifecycle flags are rejected without changing state", async () => {
  const f = setup();
  await f.create({ trialDays: 14 });
  await assert.rejects(() =>
    f.b.subscriptions.cancel("sub", {
      immediate: "false" as unknown as boolean,
    }),
  );
  await assert.rejects(() =>
    f.b.subscriptions.change("sub", {
      operationId: "bad",
      effective: "typo" as any,
    }),
  );
  assert.equal((await f.b.subscriptions.get("sub")).status, "trialing");
});

test("downgrade credit and cash refund cannot return the same paid time twice", async () => {
  const f = setup();
  await f.create({ priceId: "pro" });
  await f.b.processSubscription("sub");
  const c = (await f.b.history("sub"))[0]!;
  f.clock.advance(10);
  await f.b.subscriptions.change("sub", {
    operationId: "down",
    priceId: "basic",
    effective: "immediate",
  });
  await assert.rejects(
    () =>
      f.b.refunds.create("sub", {
        operationId: "refund",
        chargeId: c.id,
        amount: 20000,
        reason: "refund",
        actor: "operator",
      }),
    /proration credit/,
  );
});
test("prepaid refund reserves units and refuses refunds after those units have been consumed", async () => {
  const f = setup({
    prices: [
      {
        ...basic,
        meters: { units: { mode: "prepaid", included: 0, unitAmount: 10 } },
      },
    ],
  });
  await f.create();
  await f.b.processSubscription("sub");
  await f.b.usage.buy("sub", {
    operationId: "buy",
    meter: "units",
    quantity: 10,
  });
  const c = (await f.b.history("sub"))[1]!;
  await f.b.refunds.create("sub", {
    operationId: "refund",
    chargeId: c.id,
    amount: 100,
    reason: "return unused units",
    actor: "admin",
  });
  assert.equal((await f.b.usage.balance("sub", "units")).prepaid, 0);
  await f.b.usage.buy("sub", {
    operationId: "buy2",
    meter: "units",
    quantity: 10,
  });
  await f.b.usage.record("sub", {
    operationId: "use",
    meter: "units",
    quantity: 1,
  });
  const last = (await f.b.history("sub"))[2]!;
  await assert.rejects(
    () =>
      f.b.refunds.create("sub", {
        operationId: "refund3",
        chargeId: last.id,
        amount: 100,
        reason: "return",
        actor: "admin",
      }),
    /all units unused/,
  );
});

test("proration uses the discount actually applied to the paid period, not an expired catalog coupon", async () => {
  const f = setup({
    coupons: [
      {
        id: "expired_soon",
        percentBps: 2500,
        expiresAt: "2026-01-02T00:00:00Z",
      },
    ],
  });
  await f.create({ couponId: "expired_soon" });
  f.clock.set("2026-01-03");
  await f.b.processSubscription("sub");
  assert.equal((await f.b.history("sub"))[0]!.discount, 0);
  f.clock.set("2026-01-16T12:00:00Z");
  await f.b.subscriptions.change("sub", {
    operationId: "upgrade",
    priceId: "pro",
    effective: "immediate",
  });
  assert.equal((await f.b.history("sub"))[1]!.amount, 5000);
});

test("lost refund response retains reservation and replays the same refund key", async () => {
  const clock = sandboxClock(),
    p = sandboxProvider({ clock: clock.now });
  p.topUp("customer", 100000);
  const original = p.refund!;
  let once = true;
  p.refund = async (request) => {
    const result = await original(request);
    if (once) {
      once = false;
      throw new Error("response lost");
    }
    return result;
  };
  const f = setup({ providers: [p], clock: clock.now });
  await f.create();
  await f.b.processSubscription("sub");
  const input = {
    operationId: "refund",
    chargeId: (await f.b.history("sub"))[0]!.id,
    amount: 10000,
    reason: "return",
    actor: "admin",
  };
  assert.equal((await f.b.refunds.create("sub", input)).status, "pending");
  assert.equal(p.balance("customer"), 100000);
  assert.equal((await f.b.refunds.create("sub", input)).status, "paid");
  assert.equal(p.balance("customer"), 100000);
});
test("definitive refund failure restores reserved prepaid units exactly once", async () => {
  const clock = sandboxClock(),
    p = sandboxProvider({ clock: clock.now });
  p.topUp("customer", 100000);
  p.refund = async () => ({
    status: "declined",
    reason: "Refund not permitted",
  });
  const f = setup({
    providers: [p],
    clock: clock.now,
    prices: [
      {
        ...basic,
        meters: { units: { mode: "prepaid", included: 0, unitAmount: 10 } },
      },
    ],
  });
  await f.create();
  await f.b.processSubscription("sub");
  await f.b.usage.buy("sub", {
    operationId: "buy",
    meter: "units",
    quantity: 10,
  });
  const input = {
    operationId: "refund",
    chargeId: (await f.b.history("sub"))[1]!.id,
    amount: 100,
    reason: "return",
    actor: "admin",
  };
  await f.b.refunds.create("sub", input);
  await f.b.refunds.create("sub", input);
  assert.equal((await f.b.usage.balance("sub", "units")).prepaid, 10);
});

test("saved payment method capability is enforced even if an adapter exposes an extra method", async () => {
  const p = sandboxProvider();
  p.capabilities.savedPaymentMethods = false;
  const f = setup({ providers: [p] });
  await f.create();
  const token = p.registerPaymentMethod("customer");
  await assert.rejects(
    () =>
      f.b.paymentMethods.set("sub", {
        operationId: "method",
        providerId: p.id,
        token,
      }),
    /does not support/,
  );
});
