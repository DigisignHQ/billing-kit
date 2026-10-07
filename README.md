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

Connect your frontend to the backend through the typed client or optional billing portal. Customers can view their subscription, invoices, payment status and charge descriptions. Administrative actions require authorization in your backend.

## Example: monthly wallet billing

1. A customer selects a Starter plan priced at NGN 5,000 per month and receives a 14-day trial.
2. Scheduled billing produces reminders before the first payment date; your email service delivers them.
3. At the end of the trial, Billing Kit creates an invoice and asks the wallet adapter to deduct NGN 5,000.
4. Successful payment starts the paid billing period and grants the plan's access.
5. Insufficient funds trigger retries and a five-day grace period.
6. A wallet top-up followed by successful collection restores normal billing. If payment remains unpaid after grace expires, the application's entitlement checks block access.
7. The workflow repeats at each renewal.

The amounts and periods above are examples. Each application configures its own plans and policies.

## Integration guides

- [Provider adapters and payment confirmation](docs/providers.md)
- [Scheduled billing and email delivery](docs/trigger.md)
- [Billing API and business policies](docs/api.md)
- [Frontend client and billing portal](docs/http.md)
- [Storage architecture and operational limits](docs/architecture.md)
- [DigiSign integration workflow](docs/digisign-integration.md)

Real payment collection requires an implemented provider adapter. The host application supplies authentication, access enforcement, a scheduler and notification delivery.
