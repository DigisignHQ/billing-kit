import type {
  BillingOptions,
  BillingStorage,
  PaymentProvider,
  Price,
  Subscription,
  BillingEvent,
  EventType,
  CreateSubscription,
  Charge,
  PaymentResult,
  PaymentRequest,
  Configuration,
  ChangeSubscription,
  Coupon,
  InvoiceLine,
  Refund,
} from "./types.js";
import {
  DAY,
  iso,
  addDays,
  addMonths,
  integer,
  identifier,
  date,
  interval,
  nextBoundary,
  money,
  sum,
  prorate,
  discountFor,
  recurringLines,
  configAmount,
  features,
  canonical,
} from "./primitives.js";
import { defineProvider } from "./providers.js";
export type * from "./types.js";
export { addMonths };
export {
  defineProvider,
  createWebhookDelivery,
  signWebhook,
  verifyWebhookSignature,
  hmacEventVerifier,
} from "./providers.js";
export { renderInvoice } from "./documents.js";
export { createEmailNotifier } from "./notifications.js";
export type { BillingEmail } from "./notifications.js";
export { createBillingHandler, createProviderWebhookHandler } from "./http.js";
export type { BillingAction } from "./http.js";

function counter(record: Record<string, number>, key: string) {
  return Object.hasOwn(record, key) ? record[key]! : 0;
}

export function createBilling(options: BillingOptions) {
  const { storage } = options;
  identifier(options.namespace);
  const precision = {
    NGN: 2,
    USD: 2,
    EUR: 2,
    GBP: 2,
    JPY: 0,
    KWD: 3,
    ...options.currencies,
  };
  for (const [code, digits] of Object.entries(precision)) {
    if (!/^[A-Z]{3}$/.test(code)) throw new Error("Invalid currency code");
    integer(digits, "currency precision");
    if (digits > 6) throw new Error("Currency precision too large");
  }
  const prices = new Map<string, Price>(),
    coupons = new Map<string, Coupon>(),
    providers = new Map<string, PaymentProvider>();
  for (const p of options.prices) {
    identifier(p.id);
    identifier(p.planId);
    money(p.amount);
    interval(p);
    if (!Object.hasOwn(precision, p.currency))
      throw new Error("Unsupported currency");
    if (!p.name.trim()) throw new Error("Price name required");
    for (const [key, value] of Object.entries(p.features)) {
      identifier(key);
      if (typeof value !== "boolean") integer(value, "feature limit");
    }
    for (const [key, m] of Object.entries(p.meters ?? {})) {
      identifier(key);
      integer(m.included, "included units");
      money(m.unitAmount);
      if (!["metered", "prepaid"].includes(m.mode))
        throw new Error("Invalid meter mode");
    }
    if (prices.has(p.id)) throw new Error("Duplicate price ID");
    prices.set(p.id, structuredClone(p));
  }
  for (const c of options.coupons ?? []) {
    identifier(c.id);
    if ((c.amount === undefined) === (c.percentBps === undefined))
      throw new Error("Coupon needs amount or percentBps");
    if (c.amount !== undefined) {
      money(c.amount);
      if (!c.currency || !Object.hasOwn(precision, c.currency))
        throw new Error("Coupon currency required");
    }
    if (c.percentBps !== undefined) {
      integer(c.percentBps, "percentBps");
      if (c.percentBps > 10000) throw new Error("Discount exceeds 100%");
    }
    if (c.cycles !== undefined) integer(c.cycles, "coupon cycles", 1);
    if (coupons.has(c.id)) throw new Error("Duplicate coupon");
    coupons.set(c.id, {
      ...c,
      ...(c.expiresAt ? { expiresAt: date(c.expiresAt) } : {}),
    });
  }
  const configured = [...(options.providers ?? [])];
  if (options.payments)
    configured.push({
      id: "wallet",
      capabilities: {
        automaticCharges: true,
        paymentLinks: false,
        refunds: false,
        savedPaymentMethods: false,
        currencies: Object.keys(precision),
      },
      charge: (r) => options.payments!.debit(r),
    });
  for (const p of configured) {
    identifier(p.id);
    if (providers.has(p.id)) throw new Error("Duplicate provider");
    providers.set(p.id, defineProvider(p));
  }
  const defaultProvider = options.defaultProviderId ?? configured[0]?.id;
  if (!defaultProvider || !providers.has(defaultProvider))
    throw new Error("A default payment provider is required");
  const graceDays = options.graceDays ?? 5,
    retryDays = options.retryDays ?? 1;
  integer(graceDays, "graceDays");
  integer(retryDays, "retryDays", 1);
  function thresholds(v: number[]) {
    v.forEach((n) => integer(n, "reminder days", 1));
    return [...new Set(v)].sort((a, b) => a - b);
  }
  const reminderDays = thresholds(options.reminderDays ?? [10, 3, 1]),
    suspensionReminderDays = thresholds(
      options.suspensionReminderDays ?? [3, 1],
    );
  const maxStateBytes = options.maxStateBytes ?? 8_000_000;
  integer(maxStateBytes, "maxStateBytes", 1024);
  const now = () => date((options.clock?.() ?? new Date()).toISOString());
  function assertState(s: Subscription) {
    if (s.schemaVersion !== 2)
      throw new Error("Unsupported stored schema; migrate before use");
    if (s.namespace !== options.namespace)
      throw new Error("Subscription namespace mismatch");
  }
  function provider(id: string, currency: string) {
    const p = providers.get(id);
    if (!p || !p.capabilities.currencies.includes(currency))
      throw new Error("Provider does not support currency");
    return p;
  }
  function price(id: string) {
    const p = prices.get(id);
    if (!p) throw new Error("Unknown price");
    return structuredClone(p);
  }
  function event(
    s: Subscription,
    type: EventType,
    key: string,
    data: BillingEvent["data"] = {},
  ) {
    const id = `${options.namespace}:${s.id}:${type}:${key}`;
    if (!s.events.some((e) => e.id === id))
      s.events.push({
        id,
        type,
        subscriptionId: s.id,
        customerId: s.customerId,
        createdAt: now(),
        data,
      });
  }
  function operation(s: Subscription, id: string, payload: unknown) {
    identifier(id);
    const fingerprint = canonical(payload),
      old = s.operations.find((o) => o.id === id);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new Error("Operation ID reused with different parameters");
      return false;
    }
    s.operations.push({ id, fingerprint });
    return true;
  }
  async function get(id: string) {
    const s = await storage.get(id);
    if (!s) throw new Error("Subscription not found");
    assertState(s);
    return s;
  }
  async function mutate<T>(id: string, fn: (s: Subscription) => T): Promise<T> {
    for (let i = 0; i < 50; i++) {
      const s = await get(id),
        version = s.version,
        result = fn(s);
      s.version++;
      if (Buffer.byteLength(JSON.stringify(s)) > maxStateBytes)
        throw new Error(
          "Subscription storage limit reached; export and migrate history",
        );
      if (await storage.compareAndSwap(id, version, s)) return result;
    }
    throw new Error("Concurrent update conflict; retry operation");
  }
  function config(
    priceId: string,
    quantity = 1,
    addons: { priceId: string; quantity: number }[] = [],
  ): Configuration {
    integer(quantity, "quantity", 1);
    const p = price(priceId),
      seen = new Set<string>();
    if (p.kind === "addon")
      throw new Error("Add-on cannot be a base subscription");
    const items = addons.map((a) => {
      integer(a.quantity, "addon quantity", 1);
      if (seen.has(a.priceId)) throw new Error("Duplicate addon");
      seen.add(a.priceId);
      const ap = price(a.priceId);
      if (ap.kind === "base") throw new Error("Base plan cannot be an add-on");
      if (
        ap.currency !== p.currency ||
        JSON.stringify(interval(ap)) !== JSON.stringify(interval(p))
      )
        throw new Error("Addons must share currency and interval");
      if (Object.keys(ap.meters ?? {}).length)
        throw new Error("Usage meters belong to the base plan");
      return { price: ap, quantity: a.quantity };
    });
    const c = { price: p, quantity, addons: items };
    sum(recurringLines(c).map((l) => l.amount));
    return c;
  }
  function pending(s: Subscription) {
    return s.charges.find((c) => c.status !== "paid" && c.status !== "void");
  }
  function requireClear(s: Subscription) {
    if (pending(s)) throw new Error("Resolve outstanding charges first");
  }
  function hasAccess(s: Subscription, time = now()) {
    return (
      !["paused", "cancelled", "suspended"].includes(s.status) &&
      (time < s.nextBillingAt ||
        (!s.cancelAtPeriodEnd &&
          !s.pauseAtPeriodEnd &&
          time < addDays(s.nextBillingAt, s.graceDays)))
    );
  }
  function apply(s: Subscription, c: Configuration) {
    s.price = c.price;
    s.quantity = c.quantity;
    s.addons = c.addons;
  }
  function credit(
    s: Subscription,
    id: string,
    amount: number,
    reason: string,
    actor: string,
    periodEnd?: string,
  ) {
    money(amount);
    s.creditBalance = money(s.creditBalance + amount);
    s.creditEntries.push({
      id,
      amount,
      reason,
      actor,
      createdAt: now(),
      periodEnd,
    });
    event(s, "credit.issued", id, { amount, reason, actor });
  }
  function invoice(
    s: Subscription,
    input: {
      kind: Charge["kind"];
      lines: InvoiceLine[];
      start: string;
      end: string;
      description: string;
      discount?: number;
      appliedCoupon?: Coupon;
      change?: Configuration;
      prepaid?: Charge["prepaid"];
      usageKeys?: string[];
    },
  ): Charge {
    const subtotal = sum(input.lines.map((l) => l.amount)),
      discount = Math.min(subtotal, input.discount ?? 0),
      applied = Math.min(s.creditBalance, subtotal - discount);
    const sequence = s.charges.length + 1,
      id = `${options.namespace}:${s.id}:invoice:${sequence}`;
    const c: Charge = {
      id,
      number: `INV-${s.id}-${sequence}`,
      kind: input.kind,
      amount: subtotal - discount - applied,
      subtotal,
      discount,
      appliedCoupon: input.appliedCoupon,
      creditApplied: applied,
      currency: s.price.currency,
      description: input.description,
      periodStart: input.start,
      periodEnd: input.end,
      dueAt: input.start,
      status: "pending",
      lines: input.lines,
      attempts: [],
      nextAttemptAt: now(),
      change: input.change,
      prepaid: input.prepaid,
      usageKeys: input.usageKeys,
    };
    s.creditBalance -= applied;
    s.charges.push(c);
    event(s, "invoice.created", id, {
      invoiceId: id,
      amount: c.amount,
      currency: c.currency,
    });
    return c;
  }
  function usageLines(s: Subscription): {
    lines: InvoiceLine[];
    keys: string[];
  } {
    const records = s.usage.filter((r) => !r.billed);
    const groups = new Map<string, { meter: string; quantity: number }>();
    for (const r of records) {
      const key = `${r.periodStart}:${r.meter}`,
        g = groups.get(key) ?? { meter: r.meter, quantity: 0 };
      g.quantity = money(g.quantity + r.quantity);
      groups.set(key, g);
    }
    const lines: InvoiceLine[] = [];
    for (const { meter, quantity } of groups.values()) {
      const m = Object.hasOwn(s.price.meters ?? {}, meter)
        ? s.price.meters![meter]
        : undefined;
      if (!m || m.mode !== "metered" || !s.currentPeriodStart) continue;
      const over = Math.max(0, quantity - m.included * s.quantity);
      if (over)
        lines.push({
          description: `${meter} overage`,
          kind: "usage",
          quantity: over,
          unitAmount: m.unitAmount,
          amount: money(over * m.unitAmount),
        });
    }
    return { lines, keys: records.map((r) => r.key) };
  }
  function closingUsage(s: Subscription, time: string) {
    const u = usageLines(s);
    if (u.lines.length)
      return invoice(s, {
        kind: "usage",
        lines: u.lines,
        start: time,
        end: time,
        description: "Final usage charges",
        usageKeys: u.keys,
      });
    for (const r of s.usage) r.billed = true;
    return undefined;
  }
  async function create(input: CreateSubscription) {
    identifier(input.id);
    identifier(input.customerId);
    const c = config(input.priceId, input.quantity, input.addons),
      createdAt = now(),
      trial = input.trialDays ?? 14;
    integer(trial, "trialDays");
    const nextBillingAt = input.firstBillingAt
      ? date(input.firstBillingAt)
      : addDays(createdAt, trial);
    if (nextBillingAt < createdAt)
      throw new Error("First billing date must not be in the past");
    const providerId = input.providerId ?? defaultProvider!;
    provider(providerId, c.price.currency);
    const coupon = input.couponId ? coupons.get(input.couponId) : undefined;
    if (input.couponId && !coupon) throw new Error("Unknown coupon");
    if (
      coupon &&
      ((coupon.currency && coupon.currency !== c.price.currency) ||
        (coupon.expiresAt && coupon.expiresAt <= createdAt))
    )
      throw new Error("Coupon unavailable");
    const s: Subscription = {
      schemaVersion: 2,
      namespace: options.namespace,
      id: input.id,
      customerId: input.customerId,
      version: 0,
      ...c,
      status: "trialing",
      createdAt,
      nextBillingAt,
      anchorDay: new Date(nextBillingAt).getUTCDate(),
      graceDays,
      retryDays,
      reminderDays,
      suspensionReminderDays,
      cancelAtPeriodEnd: false,
      pauseAtPeriodEnd: false,
      providerId,
      coupon: coupon ? structuredClone(coupon) : undefined,
      paidCycles: 0,
      creditBalance: 0,
      creditEntries: [],
      usage: [],
      prepaid: {},
      capacity: {},
      operations: [],
      webhookIds: [],
      refunds: [],
      charges: [],
      events: [],
    };
    event(s, "subscription.created", "created", {
      trialDays: trial,
      priceId: c.price.id,
    });
    if (Buffer.byteLength(JSON.stringify(s)) > maxStateBytes)
      throw new Error("Subscription storage limit reached");
    if (!(await storage.create(s)))
      throw new Error("Subscription ID already exists");
    return s;
  }
  function normalize(result: PaymentResult): PaymentResult {
    if (
      !result ||
      !["paid", "declined", "unknown", "requires_action"].includes(
        result.status,
      )
    )
      return { status: "unknown", reason: "Invalid payment response" };
    if (
      result.status === "paid" &&
      (typeof result.reference !== "string" || !result.reference)
    )
      return { status: "unknown", reason: "Missing payment reference" };
    if (
      (result.status === "unknown" || result.status === "declined") &&
      (typeof result.reason !== "string" || !result.reason)
    )
      return { status: "unknown", reason: "Invalid provider reason" };
    if (result.status === "requires_action") {
      try {
        const url = new URL(result.paymentUrl);
        if (
          url.protocol !== "https:" ||
          typeof result.reference !== "string" ||
          !result.reference
        )
          throw new Error();
      } catch {
        return { status: "unknown", reason: "Invalid payment link" };
      }
    }
    return result;
  }
  function settle(s: Subscription, key: string, result: PaymentResult) {
    const c = s.charges.find((c) => c.attempts.some((a) => a.key === key)),
      attempt = c?.attempts.find((a) => a.key === key);
    if (
      !c ||
      !attempt ||
      !["pending", "requires_action"].includes(attempt.status)
    )
      return;
    if (result.status === "unknown") {
      attempt.reason = result.reason;
      event(s, "payment.unknown", key, {
        chargeId: c.id,
        reason: result.reason,
      });
      return;
    }
    if (result.status === "requires_action") {
      attempt.status = "requires_action";
      attempt.reference = result.reference;
      attempt.paymentUrl = result.paymentUrl;
      event(s, "payment.action_required", key, {
        chargeId: c.id,
        paymentUrl: result.paymentUrl,
      });
      return;
    }
    if (result.status === "paid") {
      attempt.status = "paid";
      attempt.reference = result.reference;
      delete attempt.paymentUrl;
      c.status = "paid";
      c.paidAt = now();
      c.receiptNumber = `RCP-${s.id}-${s.charges.indexOf(c) + 1}`;
      if (c.change) {
        apply(s, c.change);
        s.pendingChange = undefined;
        event(s, "subscription.changed", c.id, {
          priceId: s.price.id,
          quantity: s.quantity,
        });
      }
      if (c.kind === "renewal") {
        s.nextBillingAt = c.periodEnd;
        s.currentPeriodStart = c.periodStart;
        s.paidCycles++;
        s.periodCoupon = c.appliedCoupon;
        s.status = "active";
      }
      if (c.prepaid)
        s.prepaid[c.prepaid.meter] = money(
          counter(s.prepaid, c.prepaid.meter) + c.prepaid.quantity,
        );
      for (const record of s.usage)
        if (c.usageKeys?.includes(record.key)) record.billed = true;
      event(s, "payment.succeeded", c.id, {
        chargeId: c.id,
        amount: c.amount,
        currency: c.currency,
        description: c.description,
        reference: result.reference,
      });
    } else {
      attempt.status = "declined";
      attempt.reason = result.reason;
      delete attempt.paymentUrl;
      c.status = "failed";
      c.nextAttemptAt = addDays(now(), s.retryDays);
      if (c.kind === "renewal") {
        s.status =
          now() >= addDays(c.dueAt, s.graceDays) ? "suspended" : "past_due";
        if (s.status === "suspended")
          event(s, "subscription.suspended", c.id, { chargeId: c.id });
      }
      event(s, "payment.failed", key, {
        chargeId: c.id,
        reason: result.reason,
        graceEndsAt: addDays(c.dueAt, s.graceDays),
      });
    }
  }
  async function processSubscription(
    id: string,
    manual = false,
  ): Promise<Subscription> {
    const time = now();
    const work = await mutate(id, (s) => {
      let c = pending(s);
      if (!c) {
        if (s.status === "paused" || s.status === "cancelled") return null;
        if (time < s.nextBillingAt) {
          const days = s.reminderDays.find(
            (d) => (Date.parse(s.nextBillingAt) - Date.parse(time)) / DAY <= d,
          );
          if (!s.cancelAtPeriodEnd && !s.pauseAtPeriodEnd && days !== undefined)
            event(s, "renewal.reminder", `${s.nextBillingAt}:${days}`, {
              dueAt: s.nextBillingAt,
              amount: configAmount(
                s.pendingChange ?? s,
                s.coupon,
                s.paidCycles,
                time,
              ),
              currency: s.price.currency,
              days,
            });
          return null;
        }
        if (s.cancelAtPeriodEnd || s.pauseAtPeriodEnd) {
          if (s.cancelAtPeriodEnd) {
            s.status = "cancelled";
            event(s, "subscription.cancelled", s.nextBillingAt);
          } else {
            s.status = "paused";
            s.pausedAt = s.nextBillingAt;
            s.pausedStatus = "active";
            event(s, "subscription.paused", s.nextBillingAt);
          }
          c = closingUsage(s, s.nextBillingAt);
          if (!c) return null;
        } else {
          const configuration = s.pendingChange ?? s,
            u = usageLines(s),
            lines = recurringLines(configuration),
            subtotal = sum(lines.map((l) => l.amount));
          c = invoice(s, {
            kind: "renewal",
            lines: [...lines, ...u.lines],
            start: s.nextBillingAt,
            end: nextBoundary(
              s.nextBillingAt,
              configuration.price,
              s.anchorDay,
            ),
            description: `${configuration.price.name} subscription renewal`,
            discount: discountFor(subtotal, s.coupon, s.paidCycles, time),
            appliedCoupon:
              discountFor(subtotal, s.coupon, s.paidCycles, time) > 0
                ? { ...s.coupon!, cycles: undefined, expiresAt: undefined }
                : undefined,
            change: s.pendingChange,
            usageKeys: u.keys,
          });
        }
      }
      const expired = time >= addDays(c.dueAt, s.graceDays);
      if (expired && c.attempts.length && c.kind === "renewal") {
        s.status = "suspended";
        event(s, "subscription.suspended", c.id, { chargeId: c.id });
      }
      if (!expired && c.attempts.length) {
        const days = s.suspensionReminderDays.find(
          (d) =>
            (Date.parse(addDays(c!.dueAt, s.graceDays)) - Date.parse(time)) /
              DAY <=
            d,
        );
        if (days !== undefined)
          event(s, "payment.reminder", `${c.id}:${days}`, {
            chargeId: c.id,
            amount: c.amount,
            currency: c.currency,
            graceEndsAt: addDays(c.dueAt, s.graceDays),
            days,
          });
      }
      const last = c.attempts.at(-1),
        unresolved =
          last && ["pending", "requires_action"].includes(last.status);
      if (
        !unresolved &&
        !manual &&
        ((expired && c.attempts.length > 0) ||
          (c.attempts.length > 0 && c.nextAttemptAt > time))
      )
        return null;
      if (!unresolved)
        c.attempts.push({
          key: `${c.id}:attempt:${c.attempts.length + 1}`,
          startedAt: time,
          status: "pending",
          providerId: s.providerId,
          paymentMethodId: s.paymentMethod?.id,
        });
      c.status = "pending";
      const a = c.attempts.at(-1)!;
      const request: PaymentRequest = {
        idempotencyKey: a.key,
        customerId: s.customerId,
        subscriptionId: s.id,
        amount: c.amount,
        currency: c.currency,
        description: c.description,
        paymentMethodId: a.paymentMethodId,
      };
      return { providerId: a.providerId, request, reconcile: !!unresolved };
    });
    if (!work) return get(id);
    let result: PaymentResult;
    try {
      const p = provider(work.providerId, work.request.currency);
      if (work.request.amount === 0)
        result = {
          status: "paid",
          reference: `internal:${work.request.idempotencyKey}`,
        };
      else {
        const reconciled =
          work.reconcile && p.reconcile
            ? await p.reconcile(work.request)
            : { status: "not_found" as const };
        result =
          reconciled.status !== "not_found"
            ? reconciled
            : await (p.capabilities.automaticCharges
                ? p.charge!(work.request)
                : p.createPaymentLink!(work.request));
      }
    } catch {
      result = {
        status: "unknown",
        reason: "Provider error; reconciliation required",
      };
    }
    const normalized = normalize(result);
    await mutate(id, (s) => settle(s, work.request.idempotencyKey, normalized));
    return get(id);
  }
  async function processDueRenewals(
    input: { after?: string; limit?: number } = {},
  ) {
    const limit = input.limit ?? 100;
    integer(limit, "limit", 1);
    if (limit > 1000) throw new Error("Limit must not exceed 1000");
    const page = await storage.list(input.after, limit),
      results: { id: string; error?: string }[] = [];
    for (const s of page) {
      try {
        await processSubscription(s.id);
        results.push({ id: s.id });
      } catch (e) {
        results.push({
          id: s.id,
          error: e instanceof Error ? e.message : "Billing error",
        });
      }
    }
    return {
      results,
      nextCursor: page.length === limit ? page.at(-1)!.id : undefined,
    };
  }
  async function change(id: string, input: ChangeSubscription) {
    if (
      input.effective !== undefined &&
      !["immediate", "next_cycle"].includes(input.effective)
    )
      throw new Error("Invalid change timing");
    const collect = await mutate(id, (s) => {
      if (!operation(s, input.operationId, ["change", input])) return;
      requireClear(s);
      if (["cancelled", "paused", "suspended"].includes(s.status))
        throw new Error("Subscription must be active or trialing");
      const c = config(
        input.priceId ?? s.price.id,
        input.quantity ?? s.quantity,
        input.addons ??
          s.addons.map((a) => ({ priceId: a.price.id, quantity: a.quantity })),
      );
      if (c.price.currency !== s.price.currency)
        throw new Error("Currency changes require a new subscription");
      if ((input.effective ?? "next_cycle") === "next_cycle") {
        s.pendingChange = c;
        event(s, "subscription.changed", input.operationId, {
          effective: "next_cycle",
          priceId: c.price.id,
        });
        return;
      }
      if (now() >= s.nextBillingAt)
        throw new Error("Renew subscription before changing it");
      if (s.status === "trialing") {
        apply(s, c);
        event(s, "subscription.changed", input.operationId, {
          priceId: c.price.id,
        });
        return;
      }
      if (
        JSON.stringify(interval(c.price)) !== JSON.stringify(interval(s.price))
      )
        throw new Error("Interval changes take effect next cycle");
      if (
        JSON.stringify(c.price.meters ?? {}) !==
        JSON.stringify(s.price.meters ?? {})
      )
        throw new Error("Meter changes take effect next cycle");
      if (
        s.refunds.some(
          (r) =>
            r.status !== "declined" &&
            s.charges.find((c) => c.id === r.chargeId)?.periodEnd ===
              s.nextBillingAt,
        )
      )
        throw new Error("Refunded periods cannot be prorated");
      const start = s.currentPeriodStart!;
      const remaining = Date.parse(s.nextBillingAt) - Date.parse(now()),
        total = Date.parse(s.nextBillingAt) - Date.parse(start);
      const cycle = Math.max(0, s.paidCycles - 1),
        oldCost = configAmount(s, s.periodCoupon, cycle, start),
        newCost = configAmount(c, s.periodCoupon, cycle, start);
      const delta =
        prorate(newCost, remaining, total) - prorate(oldCost, remaining, total);
      if (delta > 0) {
        invoice(s, {
          kind: "adjustment",
          lines: [
            {
              description: "Prorated subscription upgrade",
              kind: "proration",
              quantity: 1,
              unitAmount: delta,
              amount: delta,
            },
          ],
          start: now(),
          end: s.nextBillingAt,
          description: "Prorated subscription change",
          change: c,
        });
        return true;
      } else {
        if (delta < 0)
          credit(
            s,
            input.operationId,
            -delta,
            "Unused subscription time",
            "billing-engine",
            s.nextBillingAt,
          );
        apply(s, c);
        s.pendingChange = undefined;
        event(s, "subscription.changed", input.operationId, {
          priceId: c.price.id,
          quantity: c.quantity,
        });
      }
    });
    return collect ? processSubscription(id) : get(id);
  }
  async function refund(
    id: string,
    input: {
      operationId: string;
      chargeId: string;
      amount: number;
      reason: string;
      actor: string;
    },
  ) {
    money(input.amount);
    if (!input.amount || !input.reason?.trim() || !input.actor?.trim())
      throw new Error("Refund requires amount, reason and actor");
    const item = await mutate(id, (s) => {
      if (!operation(s, input.operationId, ["refund", input]))
        return s.refunds.find((r) => r.id === input.operationId)!;
      const c = s.charges.find((c) => c.id === input.chargeId),
        paid = c?.attempts.find((a) => a.status === "paid");
      if (!c || c.status !== "paid" || !paid)
        throw new Error("Paid invoice required");
      if (s.creditEntries.some((e) => e.periodEnd === c.periodEnd))
        throw new Error(
          "Period already has proration credit; reconcile before cash refund",
        );
      const reserved = sum(
        s.refunds
          .filter((r) => r.chargeId === c.id && r.status !== "declined")
          .map((r) => r.amount),
      );
      if (input.amount > c.amount - reserved)
        throw new Error("Refund exceeds remaining collected amount");
      const p = provider(paid.providerId, c.currency);
      if (!p.capabilities.refunds)
        throw new Error("Provider does not support refunds");
      if (c.prepaid) {
        if (
          input.amount !== c.amount ||
          c.creditApplied ||
          counter(s.prepaid, c.prepaid.meter) < c.prepaid.quantity
        )
          throw new Error(
            "Prepaid refund requires the full cash invoice and all units unused",
          );
        s.prepaid[c.prepaid.meter] =
          counter(s.prepaid, c.prepaid.meter) - c.prepaid.quantity;
      }
      const r: Refund = {
        reservedUnits: c.prepaid,

        id: input.operationId,
        chargeId: c.id,
        amount: input.amount,
        reason: input.reason,
        actor: input.actor,
        providerId: paid.providerId,
        key: `${options.namespace}:${s.id}:refund:${input.operationId}`,
        paymentReference: paid.reference!,
        status: "pending",
        createdAt: now(),
      };
      s.refunds.push(r);
      return r;
    });
    if (item.status !== "pending") return item;
    const s = await get(id);
    let result: PaymentResult;
    try {
      result = await provider(item.providerId, s.price.currency).refund!({
        idempotencyKey: item.key,
        customerId: s.customerId,
        subscriptionId: id,
        paymentReference: item.paymentReference,
        amount: item.amount,
        currency: s.price.currency,
        reason: item.reason,
      });
    } catch {
      result = { status: "unknown", reason: "Refund reconciliation required" };
    }
    const normalized = normalize(result);
    await mutate(id, (s) => {
      const r = s.refunds.find((r) => r.id === item.id)!;
      if (r.status !== "pending") return;
      if (normalized.status === "paid") {
        r.status = "paid";
        r.reference = normalized.reference;
      } else if (normalized.status === "declined") {
        r.status = "declined";
        if (r.reservedUnits)
          s.prepaid[r.reservedUnits.meter] = money(
            counter(s.prepaid, r.reservedUnits.meter) +
              r.reservedUnits.quantity,
          );
      }
      event(s, "refund.updated", `${r.id}:${r.status}`, {
        refundId: r.id,
        status: r.status,
        amount: r.amount,
        actor: r.actor,
      });
    });
    return (await get(id)).refunds.find((r) => r.id === item.id)!;
  }
  return {
    catalog: () => ({
      prices: structuredClone([...prices.values()]),
      providers: [...providers.values()].map((p) => ({
        id: p.id,
        capabilities: structuredClone(p.capabilities),
      })),
      currencies: { ...precision },
    }),
    subscriptions: {
      create,
      get,
      change,
      cancel: async (
        id: string,
        input: { immediate?: boolean; operationId?: string } = {},
      ) => {
        if (
          input.immediate !== undefined &&
          typeof input.immediate !== "boolean"
        )
          throw new Error("Invalid immediate flag");
        await mutate(id, (s) => {
          if (
            input.operationId &&
            !operation(s, input.operationId, ["cancel", input])
          )
            return;
          requireClear(s);
          s.cancelAtPeriodEnd = true;
          s.pauseAtPeriodEnd = false;
          s.pendingChange = undefined;
          if (input.immediate || s.status === "paused") {
            s.status = "cancelled";
            closingUsage(s, now());
            event(
              s,
              "subscription.cancelled",
              input.operationId ?? String(s.version),
            );
          }
        });
        return get(id);
      },
      pause: async (
        id: string,
        input: { immediate?: boolean; operationId: string },
      ) => {
        if (
          input.immediate !== undefined &&
          typeof input.immediate !== "boolean"
        )
          throw new Error("Invalid immediate flag");
        await mutate(id, (s) => {
          if (!operation(s, input.operationId, ["pause", input])) return;
          requireClear(s);
          if (!["active", "trialing"].includes(s.status))
            throw new Error("Only active/trial subscriptions can pause");
          s.pauseAtPeriodEnd = true;
          s.cancelAtPeriodEnd = false;
          if (input.immediate) {
            if (now() >= s.nextBillingAt)
              throw new Error("Settle renewal before pausing");
            if (usageLines(s).lines.length)
              throw new Error("Unbilled overage requires pause at period end");
            s.pausedStatus = s.status as "active" | "trialing";
            s.status = "paused";
            s.pausedAt = now();
            event(s, "subscription.paused", input.operationId);
          }
        });
        return get(id);
      },
      resume: async (id: string, operationId: string) => {
        await mutate(id, (s) => {
          if (!operation(s, operationId, ["resume"])) return;
          requireClear(s);
          if (s.status === "paused") {
            const duration = Date.parse(now()) - Date.parse(s.pausedAt!);
            if (duration < 0) throw new Error("Clock moved backwards");
            s.nextBillingAt = iso(Date.parse(s.nextBillingAt) + duration);
            if (s.currentPeriodStart) {
              const previous = s.currentPeriodStart;
              s.currentPeriodStart = iso(Date.parse(previous) + duration);
              for (const r of s.usage)
                if (r.periodStart === previous && !r.billed)
                  r.periodStart = s.currentPeriodStart;
            }
            s.anchorDay = new Date(s.nextBillingAt).getUTCDate();
            s.status = s.pausedStatus ?? "active";
            delete s.pausedAt;
            delete s.pausedStatus;
          } else if (s.status === "cancelled")
            throw new Error("Use reactivate for cancelled subscriptions");
          s.pauseAtPeriodEnd = false;
          s.cancelAtPeriodEnd = false;
          event(s, "subscription.resumed", operationId);
        });
        return get(id);
      },
      reactivate: async (id: string, operationId: string) => {
        await mutate(id, (s) => {
          if (!operation(s, operationId, ["reactivate"])) return;
          requireClear(s);
          if (s.status !== "cancelled")
            throw new Error("Subscription is not cancelled");
          s.status = "trialing";
          s.nextBillingAt = now();
          s.currentPeriodStart = undefined;
          s.anchorDay = new Date(now()).getUTCDate();
          s.cancelAtPeriodEnd = false;
          s.pauseAtPeriodEnd = false;
          event(s, "subscription.reactivated", operationId);
        });
        return get(id);
      },
    },
    processSubscription,
    processDueRenewals,
    runScheduledSweep: async (
      deliver?: (event: BillingEvent) => Promise<void>,
    ) => {
      let after: string | undefined;
      let processed = 0,
        delivered = 0;
      const errors: Error[] = [];
      do {
        const page = await processDueRenewals({ after });
        for (const result of page.results) {
          processed++;
          if (result.error)
            errors.push(new Error(`${result.id}: ${result.error}`));
          if (deliver) {
            try {
              const state = await get(result.id);
              for (const event of state.events.filter((e) => !e.deliveredAt)) {
                await deliver(structuredClone(event));
                await mutate(result.id, (s) => {
                  const found = s.events.find((e) => e.id === event.id);
                  if (found) found.deliveredAt = now();
                });
                delivered++;
              }
            } catch (error) {
              errors.push(
                new Error(`${result.id}: event delivery failed`, {
                  cause: error,
                }),
              );
            }
          }
        }
        after = page.nextCursor;
      } while (after);
      if (errors.length)
        throw new AggregateError(errors, "Billing sweep needs retry");
      return { processed, delivered };
    },
    retryPayment: (id: string) => processSubscription(id, true),
    history: async (id: string) => (await get(id)).charges,
    invoices: {
      list: async (id: string) => (await get(id)).charges,
      get: async (id: string, chargeId: string) => {
        const c = (await get(id)).charges.find((c) => c.id === chargeId);
        if (!c) throw new Error("Invoice not found");
        return c;
      },
      void: async (
        id: string,
        input: {
          chargeId: string;
          operationId: string;
          reason: string;
          actor: string;
        },
      ) => {
        await mutate(id, (s) => {
          if (!operation(s, input.operationId, ["void", input])) return;
          if (!input.reason?.trim() || !input.actor?.trim())
            throw new Error("Reason and actor required");
          const c = s.charges.find((c) => c.id === input.chargeId);
          if (
            !c ||
            c.status === "paid" ||
            c.attempts.some(
              (a) => a.status === "pending" || a.status === "requires_action",
            )
          )
            throw new Error("Only definitively unpaid invoices can be voided");
          if (c.status === "void") return;
          c.status = "void";
          if (c.creditApplied)
            credit(
              s,
              input.operationId,
              c.creditApplied,
              "Voided invoice credit restoration",
              input.actor,
            );
          if (c.kind === "renewal") {
            s.status = "cancelled";
            event(s, "subscription.cancelled", input.operationId);
          }
          event(s, "invoice.voided", input.operationId, {
            invoiceId: c.id,
            reason: input.reason,
            actor: input.actor,
          });
        });
        return get(id);
      },
    },
    credits: {
      issue: async (
        id: string,
        input: {
          operationId: string;
          amount: number;
          reason: string;
          actor: string;
        },
      ) => {
        await mutate(id, (s) => {
          if (!operation(s, input.operationId, ["credit", input])) return;
          if (!input.reason?.trim() || !input.actor?.trim())
            throw new Error("Credit reason and actor required");
          credit(s, input.operationId, input.amount, input.reason, input.actor);
        });
        return get(id);
      },
    },
    refunds: {
      create: refund,
      list: async (id: string) => (await get(id)).refunds,
    },
    entitlements: {
      check: async (input: {
        subscriptionId: string;
        feature: string;
        currentUsage?: number;
        quantity?: number;
      }) => {
        const s = await get(input.subscriptionId),
          value = features(s)[input.feature],
          used =
            input.currentUsage ??
            (Object.hasOwn(s.capacity, input.feature)
              ? s.capacity[input.feature]
              : 0) ??
            0,
          q = input.quantity ?? 1;
        integer(used, "currentUsage");
        integer(q, "quantity", 1);
        return {
          allowed:
            hasAccess(s) &&
            (value === true ||
              (typeof value === "number" && q <= value - used)),
          limit: typeof value === "number" ? value : undefined,
        };
      },
      reserve: async (
        id: string,
        input: { operationId: string; feature: string; quantity: number },
      ) => {
        integer(input.quantity, "quantity", 1);
        identifier(input.feature);
        await mutate(id, (s) => {
          if (!operation(s, input.operationId, ["reserve", input])) return;
          const v = features(s)[input.feature],
            used = counter(s.capacity, input.feature);
          if (
            !hasAccess(s) ||
            !(
              v === true ||
              (typeof v === "number" && input.quantity <= v - used)
            )
          )
            throw new Error("Feature capacity exceeded");
          s.capacity[input.feature] = money(used + input.quantity);
        });
        return get(id);
      },
      release: async (
        id: string,
        input: { operationId: string; feature: string; quantity: number },
      ) => {
        integer(input.quantity, "quantity", 1);
        identifier(input.feature);
        await mutate(id, (s) => {
          if (!operation(s, input.operationId, ["release", input])) return;
          const used = counter(s.capacity, input.feature);
          if (input.quantity > used)
            throw new Error("Cannot release more capacity than reserved");
          s.capacity[input.feature] = used - input.quantity;
        });
        return get(id);
      },
    },
    usage: {
      record: async (
        id: string,
        input: { operationId: string; meter: string; quantity: number },
      ) => {
        integer(input.quantity, "quantity", 1);
        identifier(input.meter);
        await mutate(id, (s) => {
          if (!operation(s, input.operationId, ["usage", input])) return;
          if (!hasAccess(s) || now() >= s.nextBillingAt)
            throw new Error("Usage requires a current subscription period");
          const m = Object.hasOwn(s.price.meters ?? {}, input.meter)
            ? s.price.meters![input.meter]
            : undefined;
          if (!m) throw new Error("Unknown usage meter");
          const period = s.currentPeriodStart ?? s.createdAt,
            used = sum(
              s.usage
                .filter(
                  (r) => r.meter === input.meter && r.periodStart === period,
                )
                .map((r) => r.quantity),
            );
          const included = money(m.included * s.quantity),
            fromPrepaid = Math.max(
              0,
              input.quantity - Math.max(0, included - used),
            );
          if (m.mode === "prepaid" || s.status === "trialing") {
            if (fromPrepaid > counter(s.prepaid, input.meter))
              throw new Error("Prepaid allowance exhausted");
            s.prepaid[input.meter] =
              counter(s.prepaid, input.meter) - fromPrepaid;
          }
          money((used + input.quantity) * m.unitAmount);
          s.usage.push({
            key: input.operationId,
            meter: input.meter,
            quantity: input.quantity,
            periodStart: period,
            billed: false,
          });
          event(s, "usage.recorded", input.operationId, {
            meter: input.meter,
            quantity: input.quantity,
          });
        });
        return get(id);
      },
      balance: async (id: string, meter: string) => {
        const s = await get(id),
          m = Object.hasOwn(s.price.meters ?? {}, meter)
            ? s.price.meters![meter]
            : undefined;
        if (!m) throw new Error("Unknown usage meter");
        const used = sum(
          s.usage
            .filter(
              (r) =>
                r.meter === meter &&
                r.periodStart === (s.currentPeriodStart ?? s.createdAt),
            )
            .map((r) => r.quantity),
        );
        return {
          used,
          included: money(m.included * s.quantity),
          prepaid: counter(s.prepaid, meter),
          remaining: money(
            Math.max(0, m.included * s.quantity - used) +
              counter(s.prepaid, meter),
          ),
          mode: m.mode,
        };
      },
      buy: async (
        id: string,
        input: { operationId: string; meter: string; quantity: number },
      ) => {
        integer(input.quantity, "quantity", 1);
        identifier(input.meter);
        const created = await mutate(id, (s) => {
          if (!operation(s, input.operationId, ["buy", input])) return false;
          requireClear(s);
          if (!hasAccess(s)) throw new Error("Subscription unavailable");
          const m = Object.hasOwn(s.price.meters ?? {}, input.meter)
            ? s.price.meters![input.meter]
            : undefined;
          if (!m || m.mode !== "prepaid")
            throw new Error("Prepaid meter required");
          const amount = money(m.unitAmount * input.quantity);
          invoice(s, {
            kind: "prepaid",
            lines: [
              {
                description: `${input.meter} prepaid credits`,
                kind: "prepaid",
                quantity: input.quantity,
                unitAmount: m.unitAmount,
                amount,
              },
            ],
            start: now(),
            end: s.nextBillingAt,
            description: "Prepaid credit purchase",
            prepaid: { meter: input.meter, quantity: input.quantity },
          });
          return true;
        });
        return created ? processSubscription(id) : get(id);
      },
    },
    paymentMethods: {
      set: async (
        id: string,
        input: { operationId: string; providerId: string; token?: string },
      ) => {
        const snapshot = await get(id);
        const old = snapshot.operations.find((o) => o.id === input.operationId);
        if (old) {
          if (old.fingerprint !== canonical(["method", input]))
            throw new Error("Operation ID reused");
          return snapshot;
        }
        const p = provider(input.providerId, snapshot.price.currency);
        if (input.token && !p.capabilities.savedPaymentMethods)
          throw new Error("Provider does not support saved payment methods");
        const method = input.token
          ? await p.resolvePaymentMethod?.({
              customerId: snapshot.customerId,
              token: input.token,
            })
          : undefined;
        if (input.token && !method)
          throw new Error("Provider cannot resolve payment method");
        await mutate(id, (s) => {
          if (!operation(s, input.operationId, ["method", input])) return;
          if (
            s.charges.some((c) =>
              c.attempts.some(
                (a) => a.status === "pending" || a.status === "requires_action",
              ),
            )
          )
            throw new Error(
              "Resolve pending payment before switching provider",
            );
          s.providerId = p.id;
          s.paymentMethod = method
            ? { ...method, providerId: p.id }
            : undefined;
          event(s, "payment_method.changed", input.operationId, {
            providerId: p.id,
          });
        });
        return get(id);
      },
    },
    handleWebhook: async (
      providerId: string,
      request: { rawBody: string; headers: Headers },
    ) => {
      const p = providers.get(providerId);
      if (!p?.verifyWebhook)
        throw new Error("Provider does not support verified webhooks");
      const e = await p.verifyWebhook(request);
      if (
        !e ||
        typeof e.id !== "string" ||
        !e.id ||
        !e.result ||
        !["paid", "declined"].includes(e.result.status)
      )
        throw new Error("Invalid provider event");
      const normalized = normalize(e.result);
      if (normalized.status !== "paid" && normalized.status !== "declined")
        throw new Error("Invalid terminal event");
      await mutate(e.subscriptionId, (s) => {
        const eventId = `${providerId}:${e.id}`;
        if (s.webhookIds.includes(eventId)) return;
        const c = s.charges.find((c) =>
            c.attempts.some((a) => a.key === e.attemptKey),
          ),
          a = c?.attempts.find((a) => a.key === e.attemptKey);
        if (
          !c ||
          !a ||
          a.providerId !== providerId ||
          c.amount !== e.amount ||
          c.currency !== e.currency
        )
          throw new Error("Webhook does not match payment");
        if (
          (a.status === "paid" || a.status === "declined") &&
          a.status !== normalized.status
        )
          throw new Error(
            "Conflicting terminal payment event; reconcile manually",
          );
        settle(s, e.attemptKey, normalized);
        s.webhookIds.push(eventId);
      });
      return get(e.subscriptionId);
    },
    dispatchEvents: async (
      id: string,
      handler: (event: BillingEvent) => Promise<void>,
    ) => {
      const s = await get(id);
      let delivered = 0;
      for (const e of s.events.filter((e) => !e.deliveredAt)) {
        await handler(structuredClone(e));
        await mutate(id, (s) => {
          const found = s.events.find((x) => x.id === e.id);
          if (found) found.deliveredAt = now();
        });
        delivered++;
      }
      return delivered;
    },
    admin: {
      list: async (input: { after?: string; limit?: number } = {}) => {
        const limit = input.limit ?? 100;
        integer(limit, "limit", 1);
        if (limit > 1000) throw new Error("Limit too large");
        const rows = await storage.list(input.after, limit);
        rows.forEach(assertState);
        return {
          subscriptions: rows,
          nextCursor: rows.length === limit ? rows.at(-1)?.id : undefined,
        };
      },
      inspect: get,
      reconcile: (id: string) => processSubscription(id, true),
      export: async (id: string) => JSON.stringify(await get(id), null, 2),
    },
  };
}
export type Billing = ReturnType<typeof createBilling>;
