import type { Charge, Subscription } from "./types.js";
import { escapeHtml as e } from "./primitives.js";
/** Printable HTML. This is a billing statement, not jurisdiction-specific tax invoicing. */
export function renderInvoice(input: {
  subscription: Subscription;
  invoice: Charge;
  issuer?: string;
  currencyDigits?: number;
  receipt?: boolean;
}) {
  const { invoice: c, subscription: s } = input;
  if (!s.charges.some((x) => x.id === c.id))
    throw new Error("Invoice does not belong to subscription");
  if (input.receipt && c.status !== "paid")
    throw new Error("Receipt requires a paid invoice");
  const defaults: Record<string, number> = {
    NGN: 2,
    USD: 2,
    EUR: 2,
    GBP: 2,
    JPY: 0,
    KWD: 3,
  };
  const digits = input.currencyDigits ?? defaults[c.currency];
  if (digits === undefined) throw new Error("Provide currency precision");
  if (!Number.isInteger(digits) || digits < 0 || digits > 6)
    throw new Error("Invalid currency precision");
  const amount = (n: number) =>
    `${e(c.currency)} ${(n / 10 ** digits).toFixed(digits)}`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${e(c.number)}</title>
<style>body{font:16px system-ui;max-width:850px;margin:48px auto;padding:24px;color:#172234}h1{font-size:32px}table{border-collapse:collapse;width:100%;margin-top:32px}td,th{padding:12px;border-bottom:1px solid #d9e1eb;text-align:left}.total{font-size:22px;font-weight:700}small{color:#475569}@media print{body{margin:0}}</style>
<h1>${input.receipt ? "Receipt" : "Invoice"} ${e(input.receipt ? c.receiptNumber : c.number)}</h1><p>${e(input.issuer ?? "Billing")}</p>
<p>Customer: ${e(s.customerId)}<br>Subscription: ${e(s.id)}<br>Status: ${e(c.status)}<br>Period: ${e(c.periodStart)} — ${e(c.periodEnd)}<br>Due: ${e(c.dueAt)}</p>
<table><thead><tr><th>Description</th><th>Quantity</th><th>Amount</th></tr></thead><tbody>${c.lines.map((l) => `<tr><td>${e(l.description)}</td><td>${l.quantity}</td><td>${amount(l.amount)}</td></tr>`).join("")}</tbody></table>
<p>Subtotal: ${amount(c.subtotal)}<br>Discount: ${amount(c.discount)}<br>Account credit: ${amount(c.creditApplied)}</p><p class="total">${input.receipt ? "Collected" : "Total"}: ${amount(c.amount)}</p>
${c.paidAt ? `<p>Paid: ${e(c.paidAt)}</p>` : ""}<small>${e(c.description)}. Amounts exclude tax unless explicitly incorporated in your catalog.</small></html>`;
}
