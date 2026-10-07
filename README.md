# DigiSign Billing Kit

Provider-adaptable recurring billing for TypeScript applications. Billing Kit manages subscriptions, invoices, payment attempts and plan access inside your backend. Your connected wallet or payment provider collects the money.

## Billing workflow

**Define plans → subscribe a customer → send reminders → generate an invoice → collect payment → renew access.**

These short snippets follow one subscription. `storage`, `walletProvider`, `prices` and `notifications` are configured by your application. Backend examples use `billing`; frontend examples use the browser client. The package is not yet published to npm.

### 1. Configure billing

Connect PostgreSQL or MongoDB, your payment provider and your plan prices. Each price defines its currency, billing interval and included features.

```ts
import { createBilling } from '@digisign/billing-kit/server';

const billing = createBilling({
  namespace: 'yourapp-production',
  storage,
  providers: [walletProvider],
  prices,
  graceDays: 5,
  reminderDays: [10, 3, 1],
});
```

### 2. Subscribe a customer

Assign a plan and an optional trial. For example, use 14 days for new customers or 30 days for existing customers transitioning to paid billing.

```ts
await billing.subscriptions.create({
  id: 'acme_subscription',
  customerId: 'acme',
  priceId: 'starter_monthly',
  trialDays: 14,
});
```

### 3. Run scheduled billing and reminders

Call the sweep from Trigger.dev or another scheduler. It processes due billing work and emits events for your notification service, including reminders even when a wallet has sufficient funds.

```ts
await billing.runScheduledSweep(async event => {
  await notifications.deliver(event); // Deduplicate using event.id.
});
```

### 4. Create an invoice and collect payment

When a subscription is due, processing creates its invoice and requests payment through the adapter. The scheduled sweep already does this; you can also process one subscription directly.

```ts
await billing.processSubscription('acme_subscription');
const invoices = await billing.invoices.list('acme_subscription');
```

The adapter can collect from a wallet, charge a supported payment method or return a payment link. Payment links wait for verified confirmation. Stable attempt keys must prevent duplicate charges.

### 5. Confirm payment and enforce access

Confirmed payment settles the invoice and advances the billing period. Your backend checks plan entitlements before allowing protected operations.

```ts
const { allowed } = await billing.entitlements.check({
  subscriptionId: 'acme_subscription',
  feature: 'offline_signing',
});
if (!allowed) throw new Error('Subscription access required');
```

### 6. Recover failed payments

Failed payments follow your retry and grace policies. After a customer tops up their wallet, you can retry manually as well. Uncertain outcomes are reconciled before another collection is started.

```ts
const subscription = await billing.retryPayment('acme_subscription');
console.log(subscription.status);
```

Once grace expires, entitlement checks deny access. Confirmed recovery restores access according to the plan.

### 7. Manage the subscription

Schedule a plan change for the next renewal, or request an immediate prorated change. Subscriptions also support pausing, resuming, cancellation and reactivation.

```ts
await billing.subscriptions.change('acme_subscription', {
  operationId: 'acme_upgrade_001',
  priceId: 'business_monthly',
  effective: 'next_cycle',
});
```

An immediate paid upgrade takes effect after its adjustment payment succeeds. Reuse the same operation ID when retrying the same change.

### 8. Show billing in your own frontend

Use the typed client from your React, Vue, Svelte or other components. Your backend authenticates requests and checks subscription ownership and permissions.

```ts
import { createBillingClient } from '@digisign/billing-kit/client';

const client = createBillingClient({ baseUrl: '/api/billing' });
const subscription = await client.getSubscription('acme_subscription');
const invoices = await client.getHistory('acme_subscription');
```

Render the results in your own UI and call client mutations from your buttons. The prebuilt portal is optional; the client requires no DOM selector. Configure your application's CSRF protection for cookie-authenticated writes.

## Integration guides

- [Provider adapters and payment confirmation](docs/providers.md)
- [Scheduled billing and email delivery](docs/trigger.md)
- [Billing API and business policies](docs/api.md)
- [Typed frontend client and optional portal](docs/http.md)
- [Storage architecture and operational limits](docs/architecture.md)
- [DigiSign integration workflow](docs/digisign-integration.md)

Real payment collection requires an implemented provider adapter. The host application supplies authentication, access enforcement, a scheduler and notification delivery.
