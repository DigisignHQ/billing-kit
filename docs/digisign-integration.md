# DigiSign integration

This repository is standalone. No files, data, or deployment settings in DigiSign-Service have been modified.

## Confirmed context

DigiSign-Service is a TypeScript/NestJS backend using MongoDB/Mongoose. The wallet model stores a billing account, organisation, currency, balance and pricing reference. The backend already declares a Trigger.dev dependency.

The wallet balance's monetary unit and debit transaction behaviour have not been audited. Do not assume the existing balance is kobo or directly connect it to the package without verifying that contract.

## Integration sequence

1. Audit existing usage deductions, top-ups, ledger writes, monetary units and reversal flows. Establish one atomic debit path shared by usage charges and platform fees.
2. Implement the durable payment adapter. Persist attempt keys and wallet ledger results together with balance updates; recover unknown outcomes using the original key. Run failure/concurrency tests against that adapter.
3. Confirm plan names, NGN prices, team limits, signing capabilities, billing intervals and migration date. The demo catalog is illustrative only.
4. Configure separate persistent billing storage per environment. Use distinct namespaces and wallets for sandbox and production.
5. Create subscriptions with a 14-day trial for new customers and a 30-day transition for existing customers. Make onboarding/migration idempotent by stable subscription IDs and enforce one base subscription per organisation.
6. Register scheduled sweeps, notification delivery and operational alerts in the existing Trigger project.
7. Mount authorized billing HTTP routes and apply entitlements to protected API operations. Preserve access to wallet top-up, account support and billing history during suspension.
8. Connect the frontend client to those backend routes in a separate frontend task.
9. Validate the complete lifecycle in sandbox before enabling real charges. Confirm arrears, cancellation/debt-resolution and failed-payment policies explicitly.

## Decisions still open

- Final Base/Starter/Business structure and feature assignments.
- Monthly, quarterly and annual prices; discount policies.
- Exact reminder cadence before renewal and before suspension.
- Whether the proposed arrears policy is desired after extended suspension.
- Upgrade/downgrade/proration rules and treatment of existing agreements.
- Automatic retry after top-up and operational ownership of unknown payments.
- History retention, due-work indexing and public license before production/open-source release.
- Product-level staging/production toggle, which is separate from billing storage isolation.
