export type FeatureValue = boolean | number;
export interface Interval {
  unit: "day" | "week" | "month" | "year";
  count: number;
}
export interface Meter {
  included: number;
  /** Integer currency minor units per unit beyond the included allowance. */
  unitAmount: number;
  /** prepaid blocks consumption beyond purchased + included units; metered bills overages in arrears. */
  mode: "metered" | "prepaid";
}
export interface Price {
  kind?: "base" | "addon";
  id: string;
  planId: string;
  name: string;
  amount: number;
  currency: string;
  intervalMonths?: number;
  interval?: Interval;
  features: Record<string, FeatureValue>;
  meters?: Record<string, Meter>;
}
export interface Coupon {
  id: string;
  percentBps?: number;
  amount?: number;
  currency?: string;
  /** Number of renewal cycles, or omit for an ongoing discount. */
  cycles?: number;
  expiresAt?: string;
}
export type PaymentResult =
  | { status: "paid"; reference: string }
  | { status: "declined"; reason: string }
  | { status: "unknown"; reason: string }
  | { status: "requires_action"; reference: string; paymentUrl: string };
export interface PaymentRequest {
  idempotencyKey: string;
  customerId: string;
  subscriptionId: string;
  amount: number;
  currency: string;
  description: string;
  paymentMethodId?: string;
}
/** Legacy automatic wallet adapter. Durable idempotency is mandatory. */
export interface PaymentAdapter {
  debit(request: PaymentRequest): Promise<PaymentResult>;
}
export interface ProviderCapabilities {
  automaticCharges: boolean;
  paymentLinks: boolean;
  refunds: boolean;
  savedPaymentMethods: boolean;
  currencies: string[];
}
export interface PaymentMethod {
  id: string;
  label: string;
  providerId: string;
}
export interface ProviderEvent {
  id: string;
  subscriptionId: string;
  attemptKey: string;
  amount: number;
  currency: string;
  result: Extract<PaymentResult, { status: "paid" | "declined" }>;
}
export interface RefundRequest {
  idempotencyKey: string;
  customerId: string;
  subscriptionId: string;
  paymentReference: string;
  amount: number;
  currency: string;
  reason: string;
}
export interface PaymentProvider {
  id: string;
  capabilities: ProviderCapabilities;
  charge?(request: PaymentRequest): Promise<PaymentResult>;
  createPaymentLink?(request: PaymentRequest): Promise<PaymentResult>;
  /** not_found means the original request was never submitted; safe to submit with the same key. */
  reconcile?(
    request: PaymentRequest,
  ): Promise<PaymentResult | { status: "not_found" }>;
  refund?(
    request: RefundRequest,
  ): Promise<Exclude<PaymentResult, { status: "requires_action" }>>;
  /** Must verify authenticity before returning a normalized event. Never trust parsed body alone. */
  verifyWebhook?(request: {
    rawBody: string;
    headers: Headers;
  }): Promise<ProviderEvent>;
  /** Must verify that the method belongs to this customer with the provider. */
  resolvePaymentMethod?(input: {
    customerId: string;
    token: string;
  }): Promise<{ id: string; label: string }>;
}
export interface Attempt {
  key: string;
  startedAt: string;
  status: "pending" | "paid" | "declined" | "requires_action";
  providerId: string;
  paymentMethodId?: string;
  reference?: string;
  reason?: string;
  paymentUrl?: string;
}
export interface InvoiceLine {
  description: string;
  kind: "recurring" | "usage" | "proration" | "prepaid";
  quantity: number;
  unitAmount: number;
  amount: number;
}
export interface Configuration {
  price: Price;
  quantity: number;
  addons: { price: Price; quantity: number }[];
}
export interface Charge {
  appliedCoupon?: Coupon;
  id: string;
  number: string;
  kind: "renewal" | "adjustment" | "prepaid" | "usage";
  amount: number;
  subtotal: number;
  discount: number;
  creditApplied: number;
  currency: string;
  description: string;
  periodStart: string;
  periodEnd: string;
  dueAt: string;
  status: "pending" | "paid" | "failed" | "void";
  lines: InvoiceLine[];
  attempts: Attempt[];
  nextAttemptAt: string;
  paidAt?: string;
  receiptNumber?: string;
  change?: Configuration;
  prepaid?: { meter: string; quantity: number };
  usageKeys?: string[];
}
export interface Refund {
  reservedUnits?: { meter: string; quantity: number };
  id: string;
  chargeId: string;
  amount: number;
  reason: string;
  actor: string;
  providerId: string;
  key: string;
  paymentReference: string;
  status: "pending" | "paid" | "declined";
  reference?: string;
  createdAt: string;
}
export interface UsageRecord {
  key: string;
  meter: string;
  quantity: number;
  periodStart: string;
  billed: boolean;
}
export interface CreditEntry {
  periodEnd?: string;
  id: string;
  amount: number;
  reason: string;
  createdAt: string;
  actor: string;
}
export interface Operation {
  id: string;
  fingerprint: string;
}
export type EventType =
  | "subscription.created"
  | "subscription.changed"
  | "subscription.paused"
  | "subscription.resumed"
  | "subscription.reactivated"
  | "renewal.reminder"
  | "payment.failed"
  | "payment.reminder"
  | "payment.unknown"
  | "payment.action_required"
  | "payment.succeeded"
  | "subscription.suspended"
  | "subscription.cancelled"
  | "invoice.created"
  | "invoice.voided"
  | "credit.issued"
  | "refund.updated"
  | "payment_method.changed"
  | "usage.recorded";
export interface BillingEvent {
  id: string;
  type: EventType;
  subscriptionId: string;
  customerId: string;
  createdAt: string;
  data: Record<string, string | number>;
  deliveredAt?: string;
}
export interface Subscription extends Configuration {
  schemaVersion: 2;
  namespace: string;
  id: string;
  customerId: string;
  version: number;
  status:
    "trialing" | "active" | "past_due" | "suspended" | "cancelled" | "paused";
  createdAt: string;
  nextBillingAt: string;
  currentPeriodStart?: string;
  anchorDay: number;
  graceDays: number;
  retryDays: number;
  reminderDays: number[];
  suspensionReminderDays: number[];
  cancelAtPeriodEnd: boolean;
  pauseAtPeriodEnd: boolean;
  pausedAt?: string;
  pausedStatus?: "trialing" | "active";
  providerId: string;
  paymentMethod?: PaymentMethod;
  coupon?: Coupon;
  paidCycles: number;
  periodCoupon?: Coupon;
  pendingChange?: Configuration;
  creditBalance: number;
  creditEntries: CreditEntry[];
  usage: UsageRecord[];
  prepaid: Record<string, number>;
  capacity: Record<string, number>;
  operations: Operation[];
  webhookIds: string[];
  refunds: Refund[];
  charges: Charge[];
  events: BillingEvent[];
}
export interface BillingStorage {
  create(subscription: Subscription): Promise<boolean>;
  get(id: string): Promise<Subscription | null>;
  compareAndSwap(
    id: string,
    expectedVersion: number,
    next: Subscription,
  ): Promise<boolean>;
  list(after?: string, limit?: number): Promise<Subscription[]>;
}
export interface CreateSubscription {
  id: string;
  customerId: string;
  priceId: string;
  trialDays?: number;
  firstBillingAt?: string;
  quantity?: number;
  addons?: { priceId: string; quantity: number }[];
  couponId?: string;
  providerId?: string;
}
export interface ChangeSubscription {
  operationId: string;
  priceId?: string;
  quantity?: number;
  addons?: { priceId: string; quantity: number }[];
  effective?: "immediate" | "next_cycle";
}
export interface BillingOptions {
  storage: BillingStorage;
  payments?: PaymentAdapter;
  providers?: PaymentProvider[];
  defaultProviderId?: string;
  prices: Price[];
  coupons?: Coupon[];
  namespace: string;
  clock?: () => Date;
  graceDays?: number;
  retryDays?: number;
  reminderDays?: number[];
  suspensionReminderDays?: number[];
  /** Explicit precision registry. Built-ins: NGN, USD, EUR, GBP (2), JPY (0), KWD (3). */
  currencies?: Record<string, number>;
  /** Protect aggregate databases against unbounded growth. Export/migrate before this limit. */
  maxStateBytes?: number;
}
