# DigiSign Billing Kit

Provider-adaptable recurring billing for TypeScript applications. Billing Kit manages subscriptions, invoices, payment attempts and plan access inside your backend. Your connected wallet or payment provider collects the money.

## Billing workflow

**Define plans → subscribe a customer → send reminders → generate an invoice → collect payment → renew access.**

### 1. Configure billing

Connect PostgreSQL or MongoDB for billing records and a provider adapter for payment collection. Define each plan's price, currency, billing frequency, included features and usage limits.

Plans can renew monthly, quarterly, annually or at another supported interval. Optional add-ons, quantities and discounts determine what the customer pays and can access.

### 2. Subscribe a customer

Create a subscription for the customer and their selected plan. Start billing immediately or configure a trial or transition period—for example, 14 days for a new customer or 30 days for an existing customer moving onto paid plans.

Billing Kit tracks the subscription's billing date and applicable plan terms.

### 3. Run scheduled billing

Your scheduler, such as Trigger.dev or cron, calls the billing sweep regularly. It processes due subscriptions, creates reminder events, attempts collections and updates subscription states.

Connect the event handler to your email service to deliver reminders, payment notices and receipts. Reminders can be sent before billing even when the customer's wallet has sufficient funds.

### 4. Create an invoice and collect payment

When payment is due, Billing Kit creates an itemized invoice showing the plan fee, add-ons, applicable usage charges, discounts and credits.

The provider adapter handles collection:

- **Wallet:** request a deduction from the customer's wallet.
- **Automatic payment:** request a charge when the provider supports it.
- **Payment link:** request a payment link and wait for verified confirmation.

Each collection attempt has a stable idempotency key. The adapter must honour that key so repeated requests cannot charge the customer twice. Supported payment methods depend on the connected provider.

### 5. Confirm payment and renew access

After confirmed payment, Billing Kit marks the invoice as paid, advances the subscription's billing period and makes the payment record available in billing history.

Your application checks the subscription's entitlements before granting features such as offline signing, WhatsApp signing or SSO. Numeric limits can control capacity such as team members. Billing Kit determines eligibility; your backend enforces it.

### 6. Recover failed payments

A definitive payment failure follows the configured retry schedule. Customers can resolve the problem—for example, by topping up their wallet—and payment can also be retried manually.

If the payment result is uncertain, Billing Kit reconciles the original attempt before starting another collection. Payment links remain pending until confirmed.

A configurable grace period, such as five days, allows time to recover payment. After it expires, entitlement checks deny access. Successful recovery restores the subscription's access according to its plan.

### 7. Manage changes throughout the subscription

Customers can change plans, pause, resume, cancel or reactivate their subscriptions. Plan changes can take effect at the next renewal or immediately with a prorated adjustment. An immediate paid upgrade takes effect after its adjustment payment succeeds.

Applications can also record metered usage, sell prepaid units and apply account credits. Administrators can inspect invoices and payment attempts, reconcile unresolved payments, retry collections and issue supported refunds.

### 8. Show billing history

Use the typed browser client from your own React, Vue, Svelte or other application components. Your screens call your backend to load subscriptions, display billing history and request billing actions. The backend authenticates each request, checks subscription ownership and authorizes the action.

The client does not render UI or require a DOM container. A prebuilt billing portal is available as an optional integration for applications that want it; installing or using the client does not mount that portal. See the [client integration workflow](docs/http.md) for examples.

## Example: monthly wallet billing

1. A customer selects a Starter plan priced at NGN 5,000 per month and receives a 14-day trial.
2. Scheduled billing produces reminders before the first payment date; your email service delivers them.
3. At the end of the trial, Billing Kit creates an invoice and asks the wallet adapter to deduct NGN 5,000.
4. Successful payment starts the paid billing period and grants the plan's access.
5. Insufficient funds trigger retries and a five-day grace period.
6. A wallet top-up followed by successful collection restores normal billing. If payment remains unpaid after grace expires, the application's entitlement checks block access.
7. The workflow repeats at each renewal.

The amounts and periods above are examples. Each application configures its own plans and policies.

## Integration example

The following snippets show the application workflow. `db`, `walletProvider`, `notifications` and `yourAuth` are integrations supplied by your application; they are not built-in services. Package imports refer to the built Billing Kit package, which is not yet published to npm.

### Configure your backend

```ts
import { createBilling, createBillingHandler } from '@digisign/billing-kit/server';
import { mongoStorage } from '@digisign/billing-kit/adapters/mongodb';

const billing = createBilling({
  namespace: 'yourapp-production',
  storage: mongoStorage(db),
  providers: [walletProvider],
  prices: [{
    id: 'starter_monthly',
    kind: 'base',
    planId: 'starter',
    name: 'Starter',
    amount: 500000, // NGN 5,000 in kobo
    currency: 'NGN',
    interval: { unit: 'month', count: 1 },
    features: { offline_signing: true, team_members: 5 },
  }],
  graceDays: 5,
  retryDays: 1,
  reminderDays: [10, 3, 1],
});
```

For PostgreSQL, use `postgresStorage(pool)` from `@digisign/billing-kit/adapters/postgres` and call `await storage.migrate()` before using the engine. Use dedicated billing storage per environment. See the [provider adapter guide](docs/providers.md) to connect your wallet or payment provider.

### Create a subscription during onboarding

```ts
await billing.subscriptions.create({
  id: 'organisation_subscription',
  customerId: 'organisation_id',
  priceId: 'starter_monthly',
  trialDays: 14,
});
```

### Run billing from your scheduled task

```ts
await billing.runScheduledSweep(async event => {
  // Your delivery service must deduplicate using event.id.
  await notifications.deliver(event);
});
```

Register this call with Trigger.dev or your scheduler. The sweep processes reminders, due collections and retries; your event handler delivers notifications. See the [scheduler integration](docs/trigger.md).

### Authorize frontend requests in your backend

```ts
const handler = createBillingHandler({
  billing,
  authorize: async ({ request, subscriptionId, action }) => {
    const identity = await yourAuth.authenticate(request);
    // Verify ownership, action permissions and CSRF for cookie-based writes.
    const allowed = await yourAuth.canManageBilling(identity, subscriptionId, action);
    return { allowed, actor: identity?.id };
  },
});
```

Mount this Fetch-compatible handler at `/api/billing` through your backend framework. Your application implements the authentication and permission checks.

### Call the client from your own frontend components

```ts
import { createBillingClient } from '@digisign/billing-kit/client';

const client = createBillingClient({
  baseUrl: '/api/billing',
  // Supply your application's CSRF header for cookie-authenticated writes.
  // headers: () => ({ 'x-csrf-token': yourCsrfToken }),
});

const subscription = await client.getSubscription('organisation_subscription');
const invoices = await client.getHistory('organisation_subscription');

// Call from your own Retry payment button's event handler.
async function retryPayment() {
  return client.retryPayment('organisation_subscription');
}
```

Render this data in your React, Vue, Svelte or other components. Handle loading and errors, and use the returned subscription state to show the payment outcome. No DOM selector or prebuilt portal is required.

### Enforce plan features in your backend

```ts
const { allowed } = await billing.entitlements.check({
  subscriptionId: 'organisation_subscription',
  feature: 'offline_signing',
});

if (!allowed) {
  throw new Error('Your subscription does not allow offline signing');
}
// Continue with the authorized signing operation.
```

For a runnable sandbox workflow, see [the billing example](examples/demo.ts). After cloning the repository, run `npm ci` followed by `npm run demo` to observe trial expiry, a failed wallet payment, top-up and recovery without moving real money.

## Integration guides

- [Provider adapters and payment confirmation](docs/providers.md)
- [Scheduled billing and email delivery](docs/trigger.md)
- [Billing API and business policies](docs/api.md)
- [Typed frontend client and optional portal](docs/http.md)
- [Storage architecture and operational limits](docs/architecture.md)
- [DigiSign integration workflow](docs/digisign-integration.md)

Real payment collection requires an implemented provider adapter. The host application supplies authentication, access enforcement, a scheduler and notification delivery.
