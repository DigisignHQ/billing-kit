import type { Billing } from "./server.js";
import { renderInvoice } from "./documents.js";
export type BillingAction =
  | "read"
  | "history"
  | "cancel"
  | "retry"
  | "change"
  | "pause"
  | "resume"
  | "reactivate"
  | "payment_method"
  | "usage"
  | "prepaid"
  | "reserve"
  | "release"
  | "credit"
  | "refund"
  | "void"
  | "export";
export function createBillingHandler(options: {
  billing: Billing;
  basePath?: string;
  authorize: (input: {
    request: Request;
    subscriptionId: string;
    action: BillingAction;
  }) => Promise<boolean | { allowed: boolean; actor?: string }>;
  issuer?: string;
  maxBodyBytes?: number;
}) {
  const base = (options.basePath ?? "/api/billing").replace(/\/$/, "");
  const routes: Record<string, { action: BillingAction; method: string }> = {
    "": { action: "read", method: "GET" },
    catalog: { action: "read", method: "GET" },
    history: { action: "history", method: "GET" },
    invoices: { action: "history", method: "GET" },
    document: { action: "history", method: "GET" },
    cancel: { action: "cancel", method: "POST" },
    retry: { action: "retry", method: "POST" },
    change: { action: "change", method: "POST" },
    pause: { action: "pause", method: "POST" },
    resume: { action: "resume", method: "POST" },
    reactivate: { action: "reactivate", method: "POST" },
    "payment-method": { action: "payment_method", method: "POST" },
    usage: { action: "usage", method: "POST" },
    prepaid: { action: "prepaid", method: "POST" },
    reserve: { action: "reserve", method: "POST" },
    release: { action: "release", method: "POST" },
    credits: { action: "credit", method: "POST" },
    refunds: { action: "refund", method: "POST" },
    void: { action: "void", method: "POST" },
    export: { action: "export", method: "GET" },
  };
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url),
      prefix = `${base}/subscriptions/`;
    if (!url.pathname.startsWith(prefix))
      return new Response(null, { status: 404 });
    const parts = url.pathname.slice(prefix.length).split("/");
    if (parts.length > 2 || !parts[0])
      return new Response(null, { status: 404 });
    let id: string;
    try {
      id = decodeURIComponent(parts[0]);
    } catch {
      return new Response(null, { status: 400 });
    }
    const route = parts[1] ?? "",
      definition = Object.hasOwn(routes, route) ? routes[route] : undefined;
    if (!definition) return new Response(null, { status: 404 });
    if (request.method !== definition.method)
      return new Response(null, {
        status: 405,
        headers: { Allow: definition.method },
      });
    let auth: boolean | { allowed: boolean; actor?: string } = false;
    try {
      auth = await options.authorize({
        request,
        subscriptionId: id,
        action: definition.action,
      });
    } catch {
      /* fail closed */
    }
    if (!(typeof auth === "boolean" ? auth : auth.allowed))
      return new Response(null, { status: 403 });
    const actor = typeof auth === "object" ? auth.actor : undefined;
    if (["credit", "refund", "void"].includes(definition.action) && !actor)
      return new Response(null, { status: 403 });
    // Size-limit while streaming, before JSON parsing.
    let body: Record<string, any> = {};
    if (definition.method === "POST") {
      try {
        const text = await limitedText(request, options.maxBodyBytes ?? 65536);
        if (text) {
          const parsed: unknown = JSON.parse(text);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error();
          body = parsed as Record<string, unknown>;
        }
      } catch {
        return Response.json(
          { error: "Invalid or oversized JSON body" },
          { status: 400 },
        );
      }
    }
    const b = options.billing;
    try {
      if (route === "document") {
        const s = await b.subscriptions.get(id),
          c = await b.invoices.get(id, url.searchParams.get("invoiceId") ?? "");
        return new Response(
          renderInvoice({
            subscription: s,
            invoice: c,
            issuer: options.issuer,
            receipt: url.searchParams.get("receipt") === "true",
            currencyDigits:
              b.catalog().currencies[
                c.currency as keyof ReturnType<typeof b.catalog>["currencies"]
              ],
          }),
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "content-security-policy":
                "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
            },
          },
        );
      }
      let result: unknown;
      switch (route) {
        case "":
          result = await b.subscriptions.get(id);
          break;
        case "catalog":
          result = b.catalog();
          break;
        case "history":
        case "invoices":
          result = await b.history(id);
          break;
        case "cancel":
          result = await b.subscriptions.cancel(id, body);
          break;
        case "retry":
          result = await b.retryPayment(id);
          break;
        case "change":
          result = await b.subscriptions.change(id, body as any);
          break;
        case "pause":
          result = await b.subscriptions.pause(id, body as any);
          break;
        case "resume":
          result = await b.subscriptions.resume(id, body.operationId);
          break;
        case "reactivate":
          result = await b.subscriptions.reactivate(id, body.operationId);
          break;
        case "payment-method":
          result = await b.paymentMethods.set(id, body as any);
          break;
        case "usage":
          result = await b.usage.record(id, body as any);
          break;
        case "prepaid":
          result = await b.usage.buy(id, body as any);
          break;
        case "reserve":
          result = await b.entitlements.reserve(id, body as any);
          break;
        case "release":
          result = await b.entitlements.release(id, body as any);
          break;
        case "credits":
          result = await b.credits.issue(id, { ...body, actor } as any);
          break;
        case "refunds":
          result = await b.refunds.create(id, { ...body, actor } as any);
          break;
        case "void":
          result = await b.invoices.void(id, { ...body, actor } as any);
          break;
        case "export":
          return new Response(await b.admin.export(id), {
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
              "content-disposition":
                'attachment; filename="billing-export.json"',
            },
          });
      }
      return Response.json(result, {
        headers: { "cache-control": "no-store" },
      });
    } catch {
      return Response.json(
        { error: "Billing operation failed; inspect server state or logs" },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
  };
}
export async function limitedText(request: Request, maxBytes: number) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(result);
}
export function createProviderWebhookHandler(
  billing: Billing,
  providerId: string,
) {
  return async (request: Request) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    try {
      await billing.handleWebhook(providerId, {
        rawBody: await limitedText(request, 1_000_000),
        headers: request.headers,
      });
      return Response.json({ received: true });
    } catch {
      return Response.json({ error: "Webhook rejected" }, { status: 400 });
    }
  };
}
