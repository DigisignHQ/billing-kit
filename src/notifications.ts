import type { BillingEvent, Subscription } from "./types.js";
export interface BillingEmail {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}
/** Sender must durably deduplicate idempotencyKey, or accept at-least-once mail delivery. */
export function createEmailNotifier(options: {
  getSubscription: (id: string) => Promise<Subscription>;
  getCustomerEmail: (customerId: string) => Promise<string>;
  send: (email: BillingEmail) => Promise<void>;
  appName?: string;
  billingUrl?: string;
  currencyDigits?: Record<string, number>;
  clock?: () => Date;
}) {
  return async (event: BillingEvent) => {
    const s = await options.getSubscription(event.subscriptionId),
      c = s.charges.find(
        (c) => c.id === event.data.chargeId || c.id === event.data.invoiceId,
      );
    const now = (options.clock?.() ?? new Date()).toISOString();
    const digits =
      options.currencyDigits?.[s.price.currency] ??
      (
        { NGN: 2, USD: 2, EUR: 2, GBP: 2, JPY: 0, KWD: 3 } as Record<
          string,
          number
        >
      )[s.price.currency];
    if (digits === undefined)
      throw new Error("Email currency precision required");
    const amount = (n: number) =>
      `${s.price.currency} ${(n / 10 ** digits).toFixed(digits)}`;
    const name = options.appName ?? "Your subscription";
    let subject: string, text: string;
    switch (event.type) {
      case "subscription.created":
        if (s.status !== "trialing" || s.nextBillingAt <= now) return;
        subject = `${name}: trial started`;
        text = `Your ${s.price.name} trial ends on ${s.nextBillingAt}. Platform billing begins then.`;
        break;
      case "renewal.reminder":
        if (
          event.data.dueAt !== s.nextBillingAt ||
          s.nextBillingAt <= now ||
          s.cancelAtPeriodEnd ||
          s.pauseAtPeriodEnd
        )
          return;
        subject = `${name}: upcoming renewal`;
        text = `Your subscription renews on ${s.nextBillingAt}. The recurring plan amount is ${amount(Number(event.data.amount))}. Usage charges may also apply. Please ensure your payment method or wallet is ready.`;
        break;
      case "payment.failed":
      case "payment.reminder":
        if (!c || c.status === "paid" || c.status === "void") return;
        subject = `${name}: payment needed`;
        text = `Payment of ${amount(c.amount)} for ${c.number} is outstanding. ${c.description}. Please update your payment method or top up your wallet. The payment grace deadline is ${event.data.graceEndsAt}.`;
        break;
      case "payment.action_required":
        if (
          !c ||
          c.status === "paid" ||
          !c.attempts.some(
            (a) =>
              a.status === "requires_action" &&
              a.paymentUrl === event.data.paymentUrl,
          )
        )
          return;
        subject = `${name}: complete your payment`;
        text = `Complete payment of ${amount(c.amount)} for ${c.number}: ${event.data.paymentUrl}`;
        break;
      case "payment.succeeded":
        if (!c || c.status !== "paid") return;
        subject = `${name}: payment receipt`;
        text = `Payment of ${amount(c.amount)} was confirmed for ${c.number}. ${c.description}. Receipt: ${c.receiptNumber}.`;
        break;
      case "subscription.suspended":
        if (s.status !== "suspended") return;
        subject = `${name}: subscription suspended`;
        text =
          "Your subscription has been suspended after the payment grace period. Resolve the outstanding payment to restore access.";
        break;
      case "subscription.cancelled":
        if (s.status !== "cancelled") return;
        subject = `${name}: subscription cancelled`;
        text =
          "Your subscription has been cancelled. Billing history remains available.";
        break;
      case "subscription.paused":
        if (s.status !== "paused") return;
        subject = `${name}: subscription paused`;
        text =
          "Your subscription is paused. Resume it from your billing settings.";
        break;
      case "refund.updated":
        if (event.data.status !== "paid") return;
        subject = `${name}: refund confirmed`;
        text = `A refund of ${amount(Number(event.data.amount))} has been confirmed.`;
        break;
      default:
        return;
    }
    const to = await options.getCustomerEmail(s.customerId);
    if (!to || /[\r\n]/.test(to)) throw new Error("Customer email required");
    await options.send({
      to,
      subject,
      text: options.billingUrl
        ? `${text}\n\nManage billing: ${options.billingUrl}`
        : text,
      idempotencyKey: event.id,
    });
  };
}
