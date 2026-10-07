# Typed frontend client and backend integration

The primary frontend integration is a typed HTTP client used from your application's own components. It works with React, Vue, Svelte or plain JavaScript and does not render UI, select DOM elements or require the prebuilt portal.

**Your component → Billing Kit client → your authenticated backend → billing engine → database and payment provider.**

The `/client` entrypoint is browser-safe and imports no database drivers or payment credentials. `/server` owns collection and persistence; your backend supplies authentication and authorization. `/portal` is a separate, optional UI entrypoint.

## 1. Expose the backend handler

Create the billing engine in your backend, then mount this Fetch-compatible handler under `/api/billing` using your server framework's request/response adapter.

```ts
import { createBillingHandler } from '@digisign/billing-kit/server';

const handler = createBillingHandler({
  billing,
  issuer: 'Your company',
  authorize: async ({ request, subscriptionId, action }) => {
    const identity = await yourAuth.authenticate(request);
    const allowed = await yourAuth.canManageBilling(identity, subscriptionId, action);
    // Include your normal CSRF/origin check for cookie-authenticated mutations.
    return { allowed, actor: identity?.id };
  },
});
```

The application must implement the `yourAuth` functions. Being logged in is insufficient: verify subscription ownership and the permission for the specific action. Restrict `credit`, `refund`, `void` and `export` to operators. Usage/capacity mutation routes should usually be restricted to trusted backend callers rather than customers. The handler requires an actor returned by authorization for credit/refund/void; an actor in the request body is ignored.

Choose which catalog prices/coupons are offered to a customer and enforce eligibility in your integration. The default catalog contains all configured prices. Use a dedicated catalog/engine or a custom route if you have confidential negotiated pricing.

## 2. Create the browser client

```ts
import { createBillingClient } from '@digisign/billing-kit/client';

export const billingClient = createBillingClient({
  baseUrl: '/api/billing',
  // For cookie-authenticated writes, supply your application's CSRF token:
  // headers: () => ({ 'x-csrf-token': yourCsrfToken }),
});
```

The backend must verify any CSRF token your application supplies. The client does not implement an authentication or CSRF system for you.

## 3. Call billing from your own screens

```ts
// subscriptionId comes from your application's customer context.
const subscription = await billingClient.getSubscription(subscriptionId);
const invoices = await billingClient.getHistory(subscriptionId);

// Call from a user action, such as your own "Retry payment" button.
const updatedSubscription = await billingClient.retryPayment(subscriptionId);
```

Render the returned data with your normal framework components. Call mutations from event handlers, show loading/error states and refresh the displayed state after completion. A completed request can still return a subscription awaiting payment or in grace: display the returned billing state rather than assuming payment succeeded.

Subscription IDs are explicit client inputs, not proof of ownership. The backend must authorize each requested subscription. Initial subscription creation happens through the server engine in your onboarding flow; it is not a method exposed by this browser client.

No `document.querySelector`, UI mounting or React-specific dependency is needed for this workflow.

## Client methods and routes

Routes are relative to `/api/billing/subscriptions/:subscriptionId`:

| Method | Suffix | Client method |
|---|---|---|
| GET | `/` | `getSubscription` |
| GET | `/catalog` | `getCatalog` |
| GET | `/history`, `/invoices` | `getHistory` |
| GET | `/document?invoiceId=...&receipt=true` | `invoiceUrl` |
| GET | `/export` | `exportUrl` |
| POST | `/retry` | `retryPayment` |
| POST | `/change` | `changeSubscription` |
| POST | `/cancel` | `cancelSubscription` |
| POST | `/pause`, `/resume`, `/reactivate` | lifecycle methods |
| POST | `/payment-method` | `setPaymentMethod` |
| POST | `/usage`, `/prepaid` | `recordUsage`, `buyCredits` |
| POST | `/reserve`, `/release` | `reserveCapacity`, `releaseCapacity` |
| POST | `/credits`, `/refunds`, `/void` | operator actions |

Mutation payloads mirror the engine's operation inputs. The client provides a `headers()` callback for a CSRF token or your app's auth header. It uses same-origin credentials. Cross-origin deployments must implement their own CORS and credential policy.

The handler limits JSON bodies to 64 KiB by default. Errors return 400 for bad JSON, 403 for denied authorization, 404 for routes, 405 for methods, and 409 for rejected billing operations. Provider/database details are not exposed in error responses. The generic subscription response includes its billing history/audit; build a narrower DTO if your customer UI should not see all its own operational data.

## Optional prebuilt portal

Use this only if you want Billing Kit to render a ready-made billing interface instead of building your own screens. It uses the same client and authorized backend routes described above.

The `element` argument is an existing DOM container supplied by your application, such as a framework ref. Mount after that element exists and call `destroy()` when its owning component unmounts. A DOM container is required only for this optional UI, never for the client itself.

```ts
import { mountBillingPortal } from '@digisign/billing-kit/portal';

const portal = await mountBillingPortal({
  element,
  client,
  subscriptionId,
  admin: false,
  title: 'Manage your subscription',
});
await portal.refresh();
portal.destroy();
```

The component uses Shadow DOM, accessible form labels and text nodes for untrusted data. It supports plans, quantities, add-ons, payment methods, prepaid purchases, invoices/receipts and lifecycle actions. Admin mode adds credit/refund/void controls, metered usage entry and an audit view. Admin mode is visual only, never authorization.

`onChange(subscription)` can refresh surrounding application state after the portal reloads. The demo uses it to update its sandbox wallet balance.

## Local demo security boundaries

`examples/portal-server.ts` binds to 127.0.0.1, validates the Host header, creates a demo session cookie and requires a random CSRF header for writes. Its operator identity, virtual clock and wallet are demonstrations, not a deployable identity system. Do not expose the demo server publicly or use its sandbox provider for real money.
