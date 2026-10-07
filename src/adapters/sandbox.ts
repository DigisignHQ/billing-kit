import type {
  PaymentProvider,
  PaymentRequest,
  PaymentResult,
  RefundRequest,
  ProviderEvent,
} from "../types.js";
import { money, date } from "../primitives.js";
import { hmacEventVerifier, signWebhook } from "../providers.js";
export function sandboxClock(start = "2026-01-01T00:00:00Z") {
  let current = new Date(date(start));
  return {
    now: () => new Date(current),
    set: (value: string) => {
      current = new Date(date(value));
    },
    advance: (days: number) => {
      if (!Number.isFinite(days) || days < 0) throw new Error("Invalid days");
      current = new Date(current.getTime() + days * 86400000);
    },
  };
}
/** Deterministic in-memory provider, for development/testing only. Not a durable wallet. */
export function sandboxProvider(
  options: {
    id?: string;
    mode?: "automatic" | "links";
    currencies?: string[];
    secret?: string;
    clock?: () => Date;
  } = {},
) {
  const id = options.id ?? "sandbox",
    currencies = options.currencies ?? [
      "NGN",
      "USD",
      "EUR",
      "GBP",
      "JPY",
      "KWD",
    ];
  const balances = new Map<string, number>(),
    records = new Map<
      string,
      { request: PaymentRequest; result: PaymentResult }
    >(),
    refunds = new Map<
      string,
      { request: RefundRequest; result: PaymentResult }
    >();
  const methods = new Map<string, { customerId: string; label: string }>();
  let fault: "decline" | "unknown_before" | "unknown_after" | undefined;
  const key = (customer: string, currency: string) => `${customer}:${currency}`;
  function topUp(customer: string, amount: number, currency = "NGN") {
    money(amount);
    if (!currencies.includes(currency)) throw new Error("Unsupported currency");
    balances.set(
      key(customer, currency),
      money((balances.get(key(customer, currency)) ?? 0) + amount),
    );
  }
  function pay(request: PaymentRequest): PaymentResult {
    const balance =
      balances.get(key(request.customerId, request.currency)) ?? 0;
    if (balance < request.amount)
      return { status: "declined", reason: "Insufficient wallet balance" };
    balances.set(
      key(request.customerId, request.currency),
      balance - request.amount,
    );
    return { status: "paid", reference: `${id}:${request.idempotencyKey}` };
  }
  async function collect(request: PaymentRequest): Promise<PaymentResult> {
    const old = records.get(request.idempotencyKey);
    if (old) {
      if (JSON.stringify(old.request) !== JSON.stringify(request))
        throw new Error("Key parameters changed");
      return structuredClone(old.result);
    }
    money(request.amount);
    if (!currencies.includes(request.currency))
      return { status: "declined", reason: "Unsupported currency" };
    const failure = fault;
    fault = undefined;
    if (failure === "unknown_before")
      return {
        status: "unknown",
        reason: "Simulated timeout before submission",
      };
    const result: PaymentResult =
      failure === "decline"
        ? { status: "declined", reason: "Simulated decline" }
        : options.mode === "links"
          ? {
              status: "requires_action",
              reference: `link:${request.idempotencyKey}`,
              paymentUrl: `https://sandbox.billing-kit.invalid/pay/${encodeURIComponent(request.idempotencyKey)}`,
            }
          : pay(request);
    records.set(request.idempotencyKey, {
      request: structuredClone(request),
      result,
    });
    return failure === "unknown_after"
      ? { status: "unknown", reason: "Simulated lost response" }
      : structuredClone(result);
  }
  const provider: PaymentProvider = {
    id,
    capabilities: {
      automaticCharges: options.mode !== "links",
      paymentLinks: true,
      refunds: true,
      savedPaymentMethods: true,
      currencies,
    },
    charge: collect,
    createPaymentLink: collect,
    reconcile: async (request) => {
      const old = records.get(request.idempotencyKey);
      if (old && JSON.stringify(old.request) !== JSON.stringify(request))
        throw new Error("Key parameters changed");
      return structuredClone(old?.result ?? { status: "not_found" });
    },
    refund: async (request) => {
      const old = refunds.get(request.idempotencyKey);
      if (old) {
        if (JSON.stringify(old.request) !== JSON.stringify(request))
          throw new Error("Refund key changed");
        return old.result as Exclude<
          PaymentResult,
          { status: "requires_action" }
        >;
      }
      const charge = [...records.values()].find(
        (r) =>
          r.result.status === "paid" &&
          r.result.reference === request.paymentReference,
      );
      if (
        !charge ||
        charge.request.customerId !== request.customerId ||
        charge.request.currency !== request.currency
      )
        return { status: "declined", reason: "Original payment missing" };
      const already = [...refunds.values()]
        .filter(
          (r) =>
            r.request.paymentReference === request.paymentReference &&
            r.result.status === "paid",
        )
        .reduce((n, r) => n + r.request.amount, 0);
      if (request.amount > charge.request.amount - already)
        return { status: "declined", reason: "Refund exceeds payment" };
      topUp(request.customerId, request.amount, request.currency);
      const result = {
        status: "paid" as const,
        reference: `refund:${request.idempotencyKey}`,
      };
      refunds.set(request.idempotencyKey, {
        request: structuredClone(request),
        result,
      });
      return result;
    },
    resolvePaymentMethod: async ({ customerId, token }) => {
      const method = methods.get(token);
      if (!method || method.customerId !== customerId)
        throw new Error("Payment method does not belong to customer");
      return { id: token, label: method.label };
    },
    verifyWebhook: hmacEventVerifier(
      options.secret ?? "local-sandbox-secret",
      options.clock,
    ),
  };
  return Object.assign(provider, {
    topUp,
    balance: (customer: string, currency = "NGN") =>
      balances.get(key(customer, currency)) ?? 0,
    failNext: (value: typeof fault) => {
      fault = value;
    },
    registerPaymentMethod: (customerId: string, label = "Sandbox wallet") => {
      const token = `method_${methods.size + 1}`;
      methods.set(token, { customerId, label });
      return token;
    },
    completePayment: (attemptKey: string) => {
      const record = records.get(attemptKey);
      if (!record) throw new Error("Payment not found");
      if (record.result.status === "requires_action")
        record.result = pay(record.request);
      return structuredClone(record.result);
    },
    webhook: (attemptKey: string, eventId = "event_1") => {
      const record = records.get(attemptKey);
      if (!record || !["paid", "declined"].includes(record.result.status))
        throw new Error("Terminal payment required");
      const event: ProviderEvent = {
        id: eventId,
        subscriptionId: record.request.subscriptionId,
        attemptKey,
        amount: record.request.amount,
        currency: record.request.currency,
        result: record.result as ProviderEvent["result"],
      };
      const rawBody = JSON.stringify(event),
        timestamp = String(
          Math.floor((options.clock?.() ?? new Date()).getTime() / 1000),
        );
      return {
        rawBody,
        headers: new Headers({
          "x-billing-timestamp": timestamp,
          "x-billing-signature": signWebhook(
            rawBody,
            options.secret ?? "local-sandbox-secret",
            timestamp,
          ),
        }),
      };
    },
  });
}
