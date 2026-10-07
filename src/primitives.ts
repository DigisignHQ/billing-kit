import type {
  Price,
  Interval,
  Configuration,
  Coupon,
  InvoiceLine,
} from "./types.js";
export const DAY = 86_400_000;
export const iso = (n: number) => new Date(n).toISOString();
export const addDays = (s: string, n: number) => iso(Date.parse(s) + n * DAY);
export function integer(n: number, name: string, min = 0) {
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`Invalid ${name}`);
}
export function identifier(s: string) {
  if (
    typeof s !== "string" ||
    ["__proto__", "constructor", "prototype"].includes(s) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(s)
  )
    throw new Error(
      "IDs must be 1-128 letters, numbers, underscores or hyphens",
    );
}
export function date(s: string) {
  if (typeof s !== "string" || !Number.isFinite(Date.parse(s)))
    throw new Error("Invalid date");
  return new Date(s).toISOString();
}
export function addMonths(value: string, months: number, anchorDay: number) {
  const d = new Date(value);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(
    Math.min(
      anchorDay,
      new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
      ).getUTCDate(),
    ),
  );
  return d.toISOString();
}
export function interval(price: Price): Interval {
  if (price.interval && price.intervalMonths !== undefined)
    throw new Error("Choose interval or intervalMonths");
  const value = price.interval ?? {
    unit: "month",
    count: price.intervalMonths ?? 1,
  };
  if (!["day", "week", "month", "year"].includes(value.unit))
    throw new Error("Unsupported interval");
  integer(value.count, "interval count", 1);
  if (value.count > 1200) throw new Error("Interval too large");
  return value;
}
export function nextBoundary(start: string, price: Price, anchorDay: number) {
  const i = interval(price);
  return i.unit === "day" || i.unit === "week"
    ? addDays(start, i.count * (i.unit === "week" ? 7 : 1))
    : addMonths(start, i.count * (i.unit === "year" ? 12 : 1), anchorDay);
}
export function money(n: number) {
  integer(n, "monetary amount");
  return n;
}
export function sum(values: number[]) {
  return money(values.reduce((a, b) => a + b, 0));
}
export function prorate(amount: number, remaining: number, total: number) {
  if (total <= 0 || remaining < 0 || remaining > total)
    throw new Error("Invalid proration period");
  return money(
    Number(
      (BigInt(amount) * BigInt(remaining) + BigInt(Math.floor(total / 2))) /
        BigInt(total),
    ),
  );
}
export function discountFor(
  subtotal: number,
  coupon: Coupon | undefined,
  cycle: number,
  time: string,
) {
  if (
    !coupon ||
    (coupon.cycles !== undefined && cycle >= coupon.cycles) ||
    (coupon.expiresAt && time >= coupon.expiresAt)
  )
    return 0;
  return Math.min(
    subtotal,
    coupon.amount ??
      Number(
        (BigInt(subtotal) * BigInt(coupon.percentBps ?? 0) + 5000n) / 10000n,
      ),
  );
}
export function recurringLines(config: Configuration): InvoiceLine[] {
  return [
    { price: config.price, quantity: config.quantity },
    ...config.addons,
  ].map(({ price, quantity }) => ({
    description: price.name,
    kind: "recurring",
    quantity,
    unitAmount: price.amount,
    amount: money(price.amount * quantity),
  }));
}
export function configAmount(
  config: Configuration,
  coupon: Coupon | undefined,
  cycle: number,
  time: string,
) {
  const subtotal = sum(recurringLines(config).map((l) => l.amount));
  return subtotal - discountFor(subtotal, coupon, cycle, time);
}
export function features(config: Configuration) {
  const result: Record<string, boolean | number> = Object.create(null);
  for (const item of [
    { price: config.price, quantity: config.quantity },
    ...config.addons,
  ]) {
    for (const [key, value] of Object.entries(item.price.features)) {
      if (typeof value === "boolean") {
        if (value) result[key] = true;
        else if (!Object.hasOwn(result, key)) result[key] = false;
      } else if (result[key] !== true)
        result[key] = money(
          (typeof result[key] === "number" ? result[key] : 0) +
            money(value * item.quantity),
        );
    }
  }
  return result;
}
export function escapeHtml(value: unknown) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

/** Stable fingerprints across object property order and JSON database round-trips. */
export function canonical(value: unknown): string {
  function normalize(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, normalize(v)]),
      );
    return input;
  }
  return JSON.stringify(normalize(value));
}
