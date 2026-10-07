# Architecture and invariants

## Boundaries

- `server.ts`: subscription lifecycle, invoices, usage/capacity, credits, refunds and outbox operations.
- `types.ts`: portable state and adapter contracts.
- `primitives.ts`: validated money, calendar intervals, proration and stable operation fingerprints.
- `providers.ts`: provider capability checks and signed application-webhook helpers.
- `notifications.ts`: email templates and stale-notification suppression; the host supplies its sender.
- `http.ts`: Fetch-compatible routes with mandatory authorization.
- `client.ts` and `portal.ts`: browser-safe transport and a framework-neutral UI.
- `adapters/`: PostgreSQL, MongoDB, test memory storage and simulated providers.

The host application owns customer identity, authorization, catalog eligibility, provider credentials, scheduler registration, actual money movement and notification transport. The package remains independent of NestJS and DigiSign-specific schemas.

## Atomic state

One subscription is a versioned aggregate containing its configuration, invoices/attempts, usage, capacity, credit ledger, refunds, idempotent operations and outbox events. A mutation reads state, computes a new state without network side effects, then compares and swaps its version. Conflicts re-run the mutation against fresh state.

PostgreSQL uses a version-conditional update on a JSONB row. MongoDB uses a version-conditional single-document replacement with majority writes. Primary keys protect subscription identity. Both adapters return detached state. Shared tests run against real local servers and exercise concurrent renewals, stale writes, interrupted settlement, capacity reservations, refunds and restart/serialization recovery.

Financial side effects happen only after the corresponding intent is persisted. Never put a provider call or email send inside a compare-and-swap callback.

## Payment protocol

1. Persist the invoice and pending attempt, with a stable provider/key/method snapshot.
2. Collect through the provider or create a checkout link.
3. Persist confirmed settlement, invoice receipt, subscription boundary/configuration and outbox event in one update.
4. After a crash between collection and settlement, reconcile/replay the original key.
5. Start a new attempt only after a definitive decline.

The provider must durably deduplicate concurrent requests. There is no distributed transaction between a billing database and an external provider. A key cached only in memory is insufficient for real payments.

An unknown result is not a decline. Pending/action-required attempts are never discarded simply because grace expires. A verified webhook must match the original provider, attempt, amount and currency. Conflicting terminal results require investigation.

## Credits, proration and refunds

An invoice snapshots line items, discount, applied account credit and amount due. Account credit is reserved when the invoice is created and restored if an eligible unpaid invoice is voided. Invoices are never silently repriced on retry.

Proration uses integer arithmetic. The discount actually applied to the paid period is snapshotted, so expiry after invoicing or late collection cannot retroactively change its economics. A positive difference creates and attempts an adjustment; access changes only when paid. A negative difference creates account credit.

Pending refunds reserve cash capacity before calling the provider. Replays use the same refund key. A refunded current period cannot be automatically prorated, and a period with automatic proration credits cannot also be cash-refunded through the automated flow. This deliberately requires operator reconciliation instead of returning value twice.

Prepaid cash refunds require the full invoice, no applied account credit and enough unconsumed purchased units. Units are reserved before the provider call; a definitive refund decline restores them. Unknown outcomes retain the reservation.

## Usage and access

Capacity reservations use the same compare-and-swap boundary, preventing concurrent callers from exceeding seat limits. Usage operation IDs deduplicate business consumption. Included allowances reset with each paid period; prepaid units carry forward. Metered overages are collected in arrears and at termination.

Application work and billing consumption still need a recoverable workflow if they span different databases. Feature access checks are advisory for UI and authoritative only when called/enforced in backend operations. They evaluate dates as well as stored status, preventing a stopped scheduler from extending access indefinitely.

## Delivery

The outbox commits alongside billing state. Dispatch marks an event delivered only after the handler succeeds. Delivery is at least once; receiving systems must deduplicate the stable event ID. A crash after an external email send but before acknowledgement can otherwise duplicate the message.

The email helper suppresses obsolete failure/reminder messages when the invoice has since been paid or the subscription has recovered. The sender remains responsible for durable idempotency and delivery.

## Operational limits

- The current model targets modest subscription/usage workloads, not an unlimited high-volume telemetry ledger.
- The default 8 MB aggregate guard leaves room below MongoDB's document limit. Monitor aggregate size and export/migrate before reaching it; do not delete history or idempotency keys casually. Financial writes are rejected at the guard, so an unresolved provider operation may require an increased limit or a reviewed migration before local settlement can resume.
- Scheduling currently scans all subscriptions using stable pagination. A high-scale deployment needs indexed due-work selection and an archival/normalized schema with equivalent transactional guarantees.
- Never shorten idempotency retention below the provider's recovery/replay horizon.
- Dedicated storage per application/environment is required. Namespace checks catch accidental cross-environment reads; this is not a hosted multi-merchant security model.
- Version 0.2 requires stored schema 2. Older demo state is not automatically migrated.
- Amount arithmetic validates safe-integer bounds. The library does not perform foreign exchange, taxes, or jurisdiction-specific invoice numbering/compliance.

## References

- [MongoDB atomic writes](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [Trigger scheduled tasks](https://trigger.dev/docs/tasks/scheduled)
