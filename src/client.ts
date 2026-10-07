import type {
  Subscription,
  Charge,
  ChangeSubscription,
  Refund,
  Price,
  ProviderCapabilities,
} from "./types.js";
export type {
  Subscription,
  Charge,
  ChangeSubscription,
  Refund,
} from "./types.js";
export function createBillingClient(options: {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: () => HeadersInit;
}) {
  const send = options.fetch ?? globalThis.fetch;
  async function request<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const headers = new Headers(options.headers?.());
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await send(
      `${options.baseUrl.replace(/\/$/, "")}${path}`,
      {
        method,
        credentials: "same-origin",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (!response.ok)
      throw new Error(`Billing request failed (${response.status})`);
    return (await response.json()) as T;
  }
  const path = (id: string) => `/subscriptions/${encodeURIComponent(id)}`;
  const post = (id: string, action: string, body?: unknown) =>
    request<Subscription>(`${path(id)}/${action}`, "POST", body);
  return {
    getSubscription: (id: string) => request<Subscription>(path(id)),
    getHistory: (id: string) => request<Charge[]>(`${path(id)}/history`),
    getCatalog: (id: string) =>
      request<{
        prices: Price[];
        providers: { id: string; capabilities: ProviderCapabilities }[];
        currencies: Record<string, number>;
      }>(`${path(id)}/catalog`),
    cancelSubscription: (
      id: string,
      input: { operationId?: string; immediate?: boolean } = {},
    ) => post(id, "cancel", input),
    retryPayment: (id: string) => post(id, "retry"),
    changeSubscription: (id: string, input: ChangeSubscription) =>
      post(id, "change", input),
    pauseSubscription: (
      id: string,
      input: { operationId: string; immediate?: boolean },
    ) => post(id, "pause", input),
    resumeSubscription: (id: string, operationId: string) =>
      post(id, "resume", { operationId }),
    reactivateSubscription: (id: string, operationId: string) =>
      post(id, "reactivate", { operationId }),
    setPaymentMethod: (
      id: string,
      input: { operationId: string; providerId: string; token?: string },
    ) => post(id, "payment-method", input),
    recordUsage: (
      id: string,
      input: { operationId: string; meter: string; quantity: number },
    ) => post(id, "usage", input),
    buyCredits: (
      id: string,
      input: { operationId: string; meter: string; quantity: number },
    ) => post(id, "prepaid", input),
    reserveCapacity: (
      id: string,
      input: { operationId: string; feature: string; quantity: number },
    ) => post(id, "reserve", input),
    releaseCapacity: (
      id: string,
      input: { operationId: string; feature: string; quantity: number },
    ) => post(id, "release", input),
    issueCredit: (
      id: string,
      input: { operationId: string; amount: number; reason: string },
    ) => post(id, "credits", input),
    refund: (
      id: string,
      input: {
        operationId: string;
        chargeId: string;
        amount: number;
        reason: string;
      },
    ) => request<Refund>(`${path(id)}/refunds`, "POST", input),
    voidInvoice: (
      id: string,
      input: { operationId: string; chargeId: string; reason: string },
    ) => post(id, "void", input),
    invoiceUrl: (id: string, invoiceId: string, receipt = false) =>
      `${options.baseUrl.replace(/\/$/, "")}${path(id)}/document?${new URLSearchParams({ invoiceId, receipt: String(receipt) })}`,
    exportUrl: (id: string) =>
      `${options.baseUrl.replace(/\/$/, "")}${path(id)}/export`,
  };
}
export type BillingClient = ReturnType<typeof createBillingClient>;
