# API and business policies

All money values are non-negative safe integers in the currency's minor units. All timestamps are ISO UTC. Public IDs and operation IDs use letters, numbers, underscores and hyphens (1–128 characters). Treat catalog price IDs as immutable commercial versions.

## Lifecycle

| Operation | Behaviour |
|---|---|
| `subscriptions.create(input)` | Snapshot a price, quantity, add-ons, coupon and policies. Default 14-day trial. `firstBillingAt` optionally sets a future billing anchor. |
| `subscriptions.get(id)` | Read persisted state. |
| `subscriptions.change(id, input)` | Requires `operationId`. Default `effective: 'next_cycle'`. Immediate positive proration creates and attempts an invoice; configuration applies only after collection. Negative proration grants account credit. |
| `subscriptions.pause(id, { operationId, immediate? })` | Default pause at the next boundary; immediate pause freezes remaining time. Outstanding invoices must first be resolved. |
| `subscriptions.resume(id, operationId)` | Resume paused time or clear a scheduled pause/cancellation. |
| `subscriptions.cancel(id, { operationId?, immediate? })` | Default cancel at period end. Immediate cancellation stops access without an automatic refund. Cancellation while paused takes effect immediately. Final metered overages create a closing invoice. |
| `subscriptions.reactivate(id, operationId)` | Start a new, immediately due billing period after cancellation. Does not grant another free trial. |
| `processSubscription(id)` | Process one pending invoice or one due renewal. |
| `retryPayment(id)` | Retry despite the normal interval or expiry of grace. Unknown attempts always keep their original key. |
| `processDueRenewals({ after?, limit? })` | Process a stable ID-ordered page. Returns per-subscription errors and `nextCursor`. |

Pause/resume shifts the next boundary by the paused duration; it does not charge for paused time. Usage in an immediately paused paid period remains attached to that period. Immediate pause with unbilled overage is rejected; schedule pause at the boundary to settle usage first.

Billing intervals accept `{ unit: 'day' | 'week' | 'month' | 'year', count }`. The legacy `intervalMonths` shorthand remains available; supply one form. Calendar months retain the original day across short months. Currency changes require a new subscription. Immediate changes must retain the billing interval and meter definitions; change those at renewal instead.

Late renewal payments settle the original period, not a fresh period beginning at retry time. Each processing call settles at most one invoice/period, so prolonged delinquency can require multiple sweeps to settle arrears. Entitlement access still checks the current boundary. First-time delayed collection is attempted even when grace has elapsed; subsequent fresh automatic attempts stop at grace expiry. Pending attempts continue reconciling.

## Pricing

```ts
const prices = [
  { id: 'starter_v1', kind: 'base', planId: 'starter', name: 'Starter', amount: 500000,
    currency: 'NGN', interval: { unit: 'month', count: 1 },
    features: { signing: true, seats: 5 } },
  { id: 'support_v1', kind: 'addon', planId: 'support', name: 'Priority support', amount: 100000,
    currency: 'NGN', interval: { unit: 'month', count: 1 }, features: { priority_support: true } },
];
```

`quantity` multiplies the recurring price and numeric feature grants. Add-ons must share the base currency/interval and cannot define their own meters. Boolean entitlements are combined with OR; numeric grants are added. Omit `kind` only for backward-compatible catalogs; explicit kinds let the portal separate plans and add-ons.

Coupons are registered in `createBilling({ coupons })` and selected by `couponId` at subscription creation. Use either `percentBps` (0–10000 basis points) or `amount` plus `currency`, optionally `cycles` and `expiresAt`. Coupons discount recurring lines, including add-ons, but not usage overages or prepaid purchases. An invoice freezes the discount when created; an expired coupon does not retroactively change an outstanding invoice. Coupons are subscription-scoped, not a global redemption-limit system.

Proration uses integer arithmetic and rounds the old and new remaining-period costs separately to minor units. Downgrade credits remain in the same subscription/currency. Switching subscriptions does not transfer credit automatically. Refunds on the current paid period block immediate proration to avoid returning the same value twice. Conversely, a period with automatic proration credits cannot be cash-refunded without reconciliation outside this automated flow.

## Invoices, credits and refunds

- `invoices.list(id)` / `invoices.get(id, invoiceId)` / `history(id)`: itemized invoices and payment attempts.
- `renderInvoice({ subscription, invoice, issuer?, receipt?, currencyDigits? })`: escaped printable HTML. Receipts require a paid invoice. The browser's Print action can save a PDF.
- `credits.issue(id, { operationId, amount, reason, actor })`: auditable credit, applied automatically to the next created invoice. It does not rewrite an already-issued invoice.
- `refunds.create(id, { operationId, chargeId, amount, reason, actor })`: provider refund; replay the same input to reconcile an unknown refund. Pending and paid refunds reserve the refundable amount, preventing concurrent over-refunds.
- `refunds.list(id)`: inspect results. Refunds do not automatically cancel a subscription. Prepaid refunds require a full cash-only invoice and all purchased units still available; those units are reserved before the refund and restored only on a definitive decline.
- `invoices.void(id, { operationId, chargeId, reason, actor })`: only a definitively unpaid invoice can be voided. Unknown/action-required attempts must be reconciled first. Credit reserved on that invoice is restored. Voiding a renewal cancels the subscription; voiding an adjustment leaves its current plan intact.

Zero-cash invoices settle internally. Refunds only return externally collected money; they cannot refund a credit-covered portion as cash. Existing usage/financial ledgers are not replaced by these subscription-level records.

## Usage and capacity

```ts
meters: {
  verification: { mode: 'metered', included: 100, unitAmount: 200 },
  messages: { mode: 'prepaid', included: 10, unitAmount: 50 },
}
```

- `usage.record(id, { operationId, meter, quantity })`: deduplicated consumption. Metered overages bill in arrears with the next renewal or final cancellation invoice. Usage is accepted only during a current, unexpired period, not while renewal is unpaid in grace.
- `usage.balance(id, meter)`: used, included, prepaid and remaining units. Metered mode may consume beyond included units; `remaining` is the included/prepaid allowance, not an overage spending cap.
- `usage.buy(id, { operationId, meter, quantity })`: issue and attempt a prepaid-unit invoice. Units are granted only after confirmed payment. Unused purchased units carry forward; included allowances reset each paid cycle.
- Trials may consume included/prepaid allowances but do not accrue paid metered overages. Initial settlement clears trial usage.
- `entitlements.check({ subscriptionId, feature, currentUsage?, quantity? })`: a read-only access/limit check.
- `entitlements.reserve(id, { operationId, feature, quantity })`: atomically reserve capacity such as team seats.
- `entitlements.release(...)`: release previously reserved capacity, including after suspension.

Plan quantity determines included meter allowance for that period's settlement. If this is not the intended commercial policy, schedule quantity changes at the next cycle. Reserve capacity and perform the application's invitation or provisioning step with a recoverable workflow: billing storage cannot atomically commit a separate application database transaction.

## Payment methods and events

`paymentMethods.set(id, { operationId, providerId, token? })` validates currency support and asks the provider to resolve the opaque method token for the customer. Switching providers is blocked while a collection is unresolved. A definitive decline permits changing method/provider before the next attempt.

`handleWebhook(providerId, { rawBody, headers })` delegates signature verification to the adapter, then matches subscription, provider, attempt, amount and currency before settlement. Duplicate provider event IDs do not reapply a payment. Conflicting terminal events are rejected for manual/provider reconciliation.

`dispatchEvents(id, handler)` implements at-least-once delivery. Deduplicate `event.id` in the receiving service. Events include lifecycle changes, invoice creation/voiding, payment outcomes, reminders, credits, refunds and usage. A delayed notification handler should inspect current state before presenting an old failure as still outstanding.

## Operations

`admin.list({ after?, limit? })`, `admin.inspect(id)`, `admin.reconcile(id)` and `admin.export(id)` provide visibility and recovery. There is no unauthenticated admin HTTP endpoint; host applications must authorize operator access.

Sandbox tools are exported separately from `/adapters/sandbox`: `sandboxClock`, `sandboxProvider`, `failNext`, `topUp`, `registerPaymentMethod`, `completePayment` and signed test webhooks. Their state is in memory and must never handle real funds.
