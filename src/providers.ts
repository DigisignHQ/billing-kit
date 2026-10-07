import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentProvider, BillingEvent, ProviderEvent } from "./types.js";
export function defineProvider(provider: PaymentProvider): PaymentProvider {
  const c = provider.capabilities;
  if (!c.automaticCharges && !c.paymentLinks)
    throw new Error("Provider must support automatic charges or payment links");
  if (c.automaticCharges && !provider.charge)
    throw new Error("charge implementation required");
  if (c.paymentLinks && (!provider.createPaymentLink || !provider.reconcile))
    throw new Error("Payment links require createPaymentLink and reconcile");
  if (c.refunds && !provider.refund)
    throw new Error("refund implementation required");
  if (c.savedPaymentMethods && !provider.resolvePaymentMethod)
    throw new Error("resolvePaymentMethod implementation required");
  if (!c.currencies.length) throw new Error("Provider currencies required");
  return provider;
}
export function signWebhook(body: string, secret: string, timestamp: string) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}
/** Billing Kit's own HMAC protocol; provider adapters must use their provider's actual signature scheme. */
export function verifyWebhookSignature(input: {
  rawBody: string;
  headers: Headers;
  secret: string;
  now?: Date;
  toleranceSeconds?: number;
}) {
  if (!input.secret) throw new Error("Webhook secret required");
  const timestamp = input.headers.get("x-billing-timestamp") ?? "",
    signature = input.headers.get("x-billing-signature") ?? "";
  if (!/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature))
    throw new Error("Invalid webhook signature");
  const age = Math.abs(
    (input.now ?? new Date()).getTime() / 1000 - Number(timestamp),
  );
  if (age > (input.toleranceSeconds ?? 300))
    throw new Error("Webhook timestamp outside replay window");
  const expected = signWebhook(input.rawBody, input.secret, timestamp);
  if (
    !timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex"),
    )
  )
    throw new Error("Invalid webhook signature");
}
export function createWebhookDelivery(options: {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  clock?: () => Date;
}) {
  const url = new URL(options.url);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("Webhook URL must use HTTPS");
  if (!options.secret) throw new Error("Webhook secret is required");
  return async (event: BillingEvent) => {
    const raw = JSON.stringify(event),
      timestamp = String(
        Math.floor((options.clock?.() ?? new Date()).getTime() / 1000),
      );
    const response = await (options.fetch ?? fetch)(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        "content-type": "application/json",
        "x-billing-event-id": event.id,
        "x-billing-timestamp": timestamp,
        "x-billing-signature": signWebhook(raw, options.secret, timestamp),
      },
      body: raw,
    });
    if (!response.ok)
      throw new Error(`Webhook delivery failed (${response.status})`);
  };
}
export function hmacEventVerifier(secret: string, clock?: () => Date) {
  return async (request: {
    rawBody: string;
    headers: Headers;
  }): Promise<ProviderEvent> => {
    verifyWebhookSignature({ ...request, secret, now: clock?.() });
    return JSON.parse(request.rawBody) as ProviderEvent;
  };
}
