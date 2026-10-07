import type {
  BillingStorage,
  Subscription,
  PaymentAdapter,
  PaymentRequest,
  PaymentResult,
} from "../types.js";
/** For tests and local demos only. State is lost on process exit. */
export function memoryStorage(): BillingStorage {
  const rows = new Map<string, Subscription>();
  return {
    async create(s) {
      if (rows.has(s.id)) return false;
      rows.set(s.id, structuredClone(s));
      return true;
    },
    async get(id) {
      return structuredClone(rows.get(id) ?? null);
    },
    async compareAndSwap(id, version, next) {
      if (next.id !== id || next.version !== version + 1)
        throw new Error("Invalid state version");
      if (rows.get(id)?.version !== version) return false;
      rows.set(id, structuredClone(next));
      return true;
    },
    async list(after, limit = 100) {
      return [...rows.keys()]
        .sort()
        .filter((id) => after === undefined || id > after)
        .slice(0, limit)
        .map((id) => structuredClone(rows.get(id)!));
    },
  };
}
/** Demo adapter. Real adapters need a durable ledger and atomic balance + key writes. */
export function memoryWallet(
  initial: Record<string, number> = {},
): PaymentAdapter & {
  topUp(customerId: string, amount: number): void;
  balance(customerId: string): number;
} {
  const balances = new Map(Object.entries(initial));
  const results = new Map<string, { request: string; result: PaymentResult }>();
  function amount(n: number) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid amount");
  }
  for (const n of balances.values()) amount(n);
  return {
    async debit(request: PaymentRequest) {
      amount(request.amount);
      const encoded = JSON.stringify(request),
        prior = results.get(request.idempotencyKey);
      if (prior) {
        if (prior.request !== encoded)
          throw new Error("Idempotency key reused with different parameters");
        return structuredClone(prior.result);
      }
      const balance = balances.get(request.customerId) ?? 0;
      const result: PaymentResult =
        balance >= request.amount
          ? { status: "paid", reference: request.idempotencyKey }
          : { status: "declined", reason: "Insufficient wallet balance" };
      if (result.status === "paid")
        balances.set(request.customerId, balance - request.amount);
      results.set(request.idempotencyKey, { request: encoded, result });
      return structuredClone(result);
    },
    topUp(id, n) {
      amount(n);
      const total = (balances.get(id) ?? 0) + n;
      amount(total);
      balances.set(id, total);
    },
    balance: (id) => balances.get(id) ?? 0,
  };
}
