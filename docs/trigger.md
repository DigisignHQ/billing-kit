# Scheduling and email

The engine runs with Trigger.dev, cron or any worker. It does not require a Trigger account or deploy a schedule automatically.

## Trigger.dev

Register this inside your existing application after configuring persistent storage and a real provider adapter:

```ts
import { schedules } from '@trigger.dev/sdk';
import { billing, notify } from './application-billing';

export const renewSubscriptions = schedules.task({
  id: 'billing-renewals',
  cron: '0 * * * *',
  run: async () => billing.runScheduledSweep(notify),
});
```

`runScheduledSweep` consumes every page, processes due work and delivers outstanding events. It continues other subscriptions after a failure, then throws an `AggregateError` so the job can retry. Business declines are recorded outcomes, not infrastructure errors. Unknown payments create operational events that should be monitored.

The hourly cadence is an example. Each subscription's retry interval prevents every scheduled sweep from opening another fresh attempt. Uncertain attempts always retain their original key. A top-up webhook can enqueue `billing.retryPayment(subscriptionId)` after funds are durably credited.

For larger workloads, use `processDueRenewals` pagination or fan out `processSubscription` calls through your scheduler. Always start a new sweep from the first page. Use separate projects/configuration for sandbox and production.

## Ready-made email templates

```ts
import { createEmailNotifier } from '@digisign/billing-kit/server';

const notify = createEmailNotifier({
  appName: 'DigiSign',
  billingUrl: 'https://yourapp.example/billing',
  getSubscription: billing.subscriptions.get,
  getCustomerEmail: customerId => customers.emailFor(customerId),
  send: email => mailer.send({
    to: email.to,
    subject: email.subject,
    text: email.text,
    idempotencyKey: email.idempotencyKey,
  }),
});
```

`customers` and `mailer` are your application's services. The helper provides text for trials, advance renewals, payment failures, grace reminders, payment links, receipts, suspension, cancellation, pause and confirmed refunds. It sends renewal reminders even when a wallet has funds. It rechecks current state to suppress obsolete failure messages after recovery.

Supply a sender that durably deduplicates `idempotencyKey`, or accept possible duplicate emails after a crash. No real emails are sent by the local demo or tests.

For non-email actions, pass your own event handler or `createWebhookDelivery`. When delivering to multiple destinations in one handler, each destination must deduplicate independently because a partial failure retries the event.

Nothing in this repository has been deployed to Trigger. [Official scheduled-task setup](https://trigger.dev/docs/tasks/scheduled).
