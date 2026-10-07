# Provider adapters

The billing lifecycle does not depend on a specific payment company. An adapter translates the provider's API, status model and webhook authentication into a small contract. This is interoperability through adapters, not a promise that arbitrary providers implement the same HTTP API.

## Automatic collection

```ts
import { defineProvider } from '@digisign/billing-kit/server';

const provider = defineProvider({
  id: 'your_provider',
  capabilities: {
    automaticCharges: true,
    paymentLinks: false,
    refunds: false,
    savedPaymentMethods: false,
    currencies: ['NGN'],
  },
  charge: async request => {
    // Call your provider with request.idempotencyKey, amount, currency and customer mapping.
    // Map its response, preserving uncertainty:
    // return { status: 'paid', reference: providerReference };
    // return { status: 'declined', reason: definitiveFailure };
    // return { status: 'unknown', reason: 'Provider has not confirmed the outcome' };
    return yourCollectionImplementation(request);
  },
  reconcile: async request => {
    // Retrieve the ORIGINAL operation by key/reference. Return not_found only
    // if no operation was accepted, so submission with that same key is safe.
    return yourReconciliationImplementation(request);
  },
});
```

`yourCollectionImplementation` and `yourReconciliationImplementation` above are integration points, not functions supplied by the package. The runnable implementation is `src/adapters/sandbox.ts`.

An existing `{ debit(request) }` wallet adapter is still accepted through `createBilling({ payments })`; it is treated as an automatic provider called `wallet`.

## Required financial guarantees

1. Use integer minor units in the specified currency. Do not guess whether the provider expects major/minor units; convert explicitly at the boundary.
2. Deduplicate concurrent requests atomically by `idempotencyKey`. Reusing a key with changed parameters must fail.
3. Persist/retrieve terminal outcomes across restarts for the complete recovery horizon. A cache in one process is not sufficient.
4. Never call a timeout a decline. `unknown` retains the original attempt key; `declined` permits a new attempt and must mean no funds moved.
5. A `paid` response must represent durable confirmation and contain a provider reference. Submission/authorization alone is not settlement.
6. For a wallet, balance deduction, operation key and ledger entry must commit atomically. Existing usage deductions must use the same concurrency discipline.
7. Reconcile the original operation after the provider collects but before the application's state update succeeds.

The SDK persists the attempt before calling the provider. Repeated calls can happen concurrently, so adapters must satisfy these guarantees even when a scheduler normally runs one worker.

## Payment-link providers

Advertise `automaticCharges: false`, `paymentLinks: true`, and implement both `createPaymentLink` and `reconcile`.

```ts
return {
  status: 'requires_action',
  reference: checkoutReference,
  paymentUrl: checkoutHttpsUrl,
};
```

The same attempt remains pending while the customer completes checkout. A verified webhook or reconciliation changes it to paid/declined. The engine never grants a paid upgrade merely because checkout was created. Expired checkouts should only become `declined` when the provider confirms they cannot still settle; uncertain expiry remains pending.

When a provider supports both modes, the engine calls automatic `charge`; that adapter can itself return `requires_action` when customer action is needed. To select a link-only flow, register a distinct provider configuration with automatic collection disabled.

## Incoming webhooks

Implement `verifyWebhook({ rawBody, headers })` using the provider's official signing scheme. Verify the original bytes before parsing. Return:

```ts
{
  id: providerEventId,
  subscriptionId,
  attemptKey,
  amount, currency,
  result: { status: 'paid', reference: providerPaymentReference },
}
```

Store the attempt/customer mapping when initiating collection. Do not trust an arbitrary browser-supplied subscription ID, amount or payment reference.

Mount `createProviderWebhookHandler(billing, providerId)` to expose the verified flow. It returns 400 on rejected/conflicting events, allowing the host to log/alert. Keep provider endpoints distinct from customer authentication endpoints.

`signWebhook`, `verifyWebhookSignature` and `hmacEventVerifier` implement Billing Kit's own timestamped HMAC-SHA256 protocol for sandbox/internal integrations. They do **not** replace a third-party provider's signature scheme. The default replay window is five minutes. Provider event IDs are also durably deduplicated in subscription state.

## Refunds

Advertise `refunds: true` and implement `refund(request)` with the same durable idempotency/reconciliation discipline. The request includes the original payment reference and a stable refund key. The kit reserves the amount before the external call so concurrent refunds cannot exceed collection. A timeout leaves the refund pending; replay `refunds.create` with the same operation/input to reconcile it.

Do not enable the capability if the provider cannot refund. A refund is not the same as granting an account credit: the latter is entirely inside the billing ledger.

## Saved payment methods

Advertise `savedPaymentMethods: true` and implement `resolvePaymentMethod({ customerId, token })`. Verify ownership with the provider before returning `{ id, label }`. The subscription stores only that opaque ID/label; actual card data should never enter this SDK or its HTTP routes.

The provider's secure setup UI/SDK is responsible for generating the token. The generic portal accepts an opaque token as a development integration point; production applications should embed their chosen provider's hosted setup flow.

## Outgoing application webhooks

```ts
const deliver = createWebhookDelivery({
  url: 'https://yourapp.example/billing-events',
  secret: process.env.BILLING_WEBHOOK_SECRET!,
});
await billing.dispatchEvents(subscriptionId, deliver);
```

The delivery helper signs `timestamp + '.' + body` with HMAC-SHA256 and sends `x-billing-timestamp`, `x-billing-signature`, and `x-billing-event-id`. Delivery is at least once. Use the event ID to deduplicate after verifying the signature. HTTP destinations are limited to loopback; production destinations require HTTPS. Redirects are not followed, and requests time out after ten seconds.
