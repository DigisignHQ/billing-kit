# DigiSign Billing Kit

Recurring billing for applications that already have a payment provider.

Define your prices, connect a provider and a database, then run the billing sweep. Billing Kit manages subscriptions, invoices, collection attempts, reminders and feature access. Your provider moves the money.

**Local development release: 0.2.0.** The features below are implemented and exercised with sandbox providers. No production payment provider credentials, deployments or public package publication are configured.

## Try the complete workflow

Requires Node.js 22.13 or newer. The package ships ESM and CommonJS entrypoints.

```sh
npm ci
npm run demo:portal
```

Open **http://127.0.0.1:4318**. The demo contains a customer portal, an admin view, a simulated wallet, a payment-link provider and a controllable clock. Nothing charges real money. Restarting the demo clears its in-memory data.

1. **End the trial.** Click **Advance 14 days**. An invoice appears and fails because the wallet is empty.
2. **Recover payment.** Click **Add NGN 50,000 to sandbox wallet**, then **Retry payment**. The subscription becomes active and an invoice/receipt is available.
3. **Change the plan.** Select Business and “Immediately (prorated)”, then **Update plan**. An adjustment invoice is created and collected automatically; the upgrade activates after confirmation. If collection fails, use **Retry payment** after resolving it. “Next renewal” schedules a change without charging immediately.
4. **Try other pricing.** Add Priority support, change the plan quantity, or buy prepaid message units. The sample subscription has a 20% introductory discount on its first renewal.
5. **See administration.** Click **Switch customer / admin view**. Record verification usage, inspect payment attempts/events, issue account credit, or refund a collected amount. Amount inputs in this example use minor units: 100 kobo = NGN 1.
6. **Test payment links.** Select `sandbox_links` under Payment method and save. Buy prepaid units to generate a payment link, then click **Confirm sandbox payment link** in the sandbox toolbar. This simulates a verified provider webhook; the link itself is a deliberately non-live example URL.
7. **Test the lifecycle.** Pause, resume or schedule cancellation. Advance the clock and run billing to see renewal, grace and suspension behaviour. A cancelled subscription can be reactivated.

The separate CLI demo runs a short trial → failure → top-up → recovery sequence:

```sh
npm run demo
```

## What works

| Capability | Implementation |
|---|---|
| Provider adapters | Automatic collection or payment links; explicit capability/currency checks |
| Recurrence | Daily, weekly, monthly, quarterly, annual and custom integer intervals; explicit first billing date |
| Lifecycle | Trials, renewals, pause/resume, cancellation and reactivation |
| Plan changes | Immediate proration or a scheduled change at the next renewal |
| Recovery | Idempotent attempts, automatic/manual retries, grace periods, reminders and reconciliation |
| Billing documents | Itemized invoices and printable HTML receipts |
| Add-ons and quantities | Recurring line items, per-unit pricing and combined feature grants |
| Usage | Metered overages in arrears, included allowances and prepaid unit purchases |
| Discounts and credits | Fixed/percentage coupons, limited-cycle discounts and audited account credits |
| Currency | Explicit currency prices in integer minor units; configurable precision |
| Payment methods | Provider-verified method tokens and provider switching when no collection is unresolved |
| Events | Durable outbox, verified incoming provider events and signed outgoing webhooks |
| Customer portal | Framework-neutral browser component and typed API client |
| Operations | Attempt inspection, retry/reconciliation, partial refunds, invoice voiding and JSON export |
| Storage | PostgreSQL, MongoDB and a test-only memory adapter |
| Testing | Sandbox providers, simulated failures, payment links and virtual time |

## The application workflow

**Create subscription → wait for billing date → create invoice → collect through provider → confirm payment → activate/renew access → emit events.**

A definitive failure schedules another attempt. An uncertain outcome reuses the original attempt until reconciled. A payment link waits for provider confirmation. A missed payment eventually suspends access according to your grace policy.

### 1. Configure the engine

Build the local package before installing it into another application with `npm install /absolute/path/to/billing-kit`. The package is not published to npm.

```ts
import { createBilling } from '@digisign/billing-kit/server';
import { mongoStorage } from '@digisign/billing-kit/adapters/mongodb';

const billing = createBilling({
  namespace: 'yourapp-production',
  storage: mongoStorage(db), // your connected MongoDB Db
  providers: [yourProvider], // implement the adapter contract below
  prices: [{
    id: 'starter_monthly_v1',
    kind: 'base',
    planId: 'starter',
    name: 'Starter',
    amount: 500000, // example only: NGN 5,000 in kobo
    currency: 'NGN',
    interval: { unit: 'month', count: 1 },
    features: { offline_signing: true, team_members: 5 },
    meters: {
      verification: { mode: 'metered', included: 100, unitAmount: 200 },
    },
  }],
  graceDays: 5,
  retryDays: 1,
  reminderDays: [10, 3, 1],
  suspensionReminderDays: [3, 1],
});
```

For PostgreSQL, replace the storage adapter:

```ts
import { postgresStorage } from '@digisign/billing-kit/adapters/postgres';
const storage = postgresStorage(pool);
await storage.migrate(); // explicit, additive table creation
```

Install only the driver you use: `mongodb` 6.x or `pg` 8.x. Connections belong to the host application; the engine does not close them. Use dedicated storage and a distinct namespace for each environment.

### 2. Create a customer subscription

```ts
await billing.subscriptions.create({
  id: 'organisation_subscription',
  customerId: 'organisation_id',
  priceId: 'starter_monthly_v1',
  trialDays: 14, // use 30 for an existing-customer transition
});
```

Stable subscription IDs prevent duplicate creation. The host decides which customer is eligible for which plan and whether only one base subscription is allowed.

### 3. Run billing and deliver notifications

```ts
await billing.runScheduledSweep(async event => {
  // Send an email or update your application. Deduplicate event.id durably.
  await notifications.deliver(event);
});
```

Register this sweep in Trigger.dev, cron or your existing worker. The helper consumes all pages and reports failures after processing the remaining subscriptions. [Trigger recipe](docs/trigger.md) includes ready-made email templates.

### 4. Enforce access in the backend

```ts
const { allowed } = await billing.entitlements.check({
  subscriptionId,
  feature: 'offline_signing',
});

// Atomically reserve limited capacity instead of checking and incrementing separately.
await billing.entitlements.reserve(subscriptionId, {
  operationId: 'invite_123', feature: 'team_members', quantity: 1,
});

// Record metered consumption exactly once per business operation.
await billing.usage.record(subscriptionId, {
  operationId: 'verification_123', meter: 'verification', quantity: 1,
});
```

Use a durable business operation ID and reuse it on retries. Entitlement checks protect access even if the scheduler is delayed. Reservation and usage operations are atomic within billing storage; coordinate them with your application's work using a durable workflow/outbox when necessary.

### 5. Connect the frontend

Mount `createBillingHandler` in your backend and implement authentication, subscription ownership, role checks and CSRF protection in its required authorization callback. Then use the client or optional portal:

```ts
import { createBillingClient } from '@digisign/billing-kit/client';
import { mountBillingPortal } from '@digisign/billing-kit/portal';

const client = createBillingClient({ baseUrl: '/api/billing' });
await mountBillingPortal({
  element: document.querySelector('#billing')!,
  client,
  subscriptionId,
});
```

The server remains authoritative. `admin: true` only shows controls; it does not grant permissions. [HTTP and portal integration](docs/http.md).

## Connecting a real provider

Implement `PaymentProvider` using `defineProvider`. Advertise supported currencies and capabilities, then map your provider's API responses into `paid`, `declined`, `unknown` or `requires_action`.

The critical contract is **durable idempotency**: concurrent/replayed calls with the same attempt key must never collect twice. If your provider cannot guarantee that, your adapter needs its own durable operation ledger and reconciliation. Never convert a timeout into a definitive decline.

[Provider guide](docs/providers.md) explains automatic charges, payment links, webhook verification, refunds and saved payment methods. The sandbox adapters prove these flows but are not production money stores. No adapter can add direct debit to a provider that does not support it.

## Reference and validation

- [API and business policies](docs/api.md)
- [Architecture and financial invariants](docs/architecture.md)
- [DigiSign integration](docs/digisign-integration.md)
- [HTTP and portal](docs/http.md)
- [Provider contract](docs/providers.md)
- [Trigger scheduling](docs/trigger.md)
- [Validation results and demo preview](docs/validation.md)

```sh
npm run check                 # build + unit/workflow/browser-DOM tests
npm run typecheck            # source, tests and examples
npm run format:check
npm run test:local-databases  # real disposable PostgreSQL + MongoDB servers
npm pack --dry-run           # verify package exports and contents
```

The database script requires local `initdb`, `pg_ctl` and `mongod` binaries. It uses temporary databases bound to loopback, cleans them up, and never connects to DigiSign's databases.

## Deployment boundaries

This package supplies a working billing engine, not a production payment account or a hosted multi-merchant platform. Connect and validate your real provider, identity system, notification service and scheduler before enabling real charges. Currency changes require a new subscription; there is no foreign-exchange conversion or tax calculation. Invoice HTML is a billing record, not jurisdiction-specific tax compliance.

The current schema stores a subscription and its history as one atomic aggregate. A configurable 8 MB guard prevents unlimited document growth; high-volume usage deployments need an archival/normalized storage strategy before reaching it. Scans currently visit all subscriptions. Details and operational tradeoffs are in the architecture document.

Version 0.2 uses storage schema 2. Version 0.1 local/demo state is not migrated automatically. The repository is public. The npm package remains unpublished (`private: true`), and no open-source license has been selected yet (`UNLICENSED`). Public visibility does not grant an open-source license.
