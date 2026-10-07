import type { BillingClient } from "./client.js";
import type { Subscription } from "./types.js";
const css = `:host{display:block;color:#17243c;font:15px/1.5 system-ui,-apple-system,sans-serif}*{box-sizing:border-box}h1,h2,h3,p{margin:0}h1{font-size:30px;letter-spacing:-1px}h2{font-size:19px;margin-bottom:16px}h3{font-size:15px}header{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:24px}.muted{color:#65748b;font-size:13px}.badge{display:inline-block;border-radius:24px;padding:5px 12px;background:#e8f1ff;color:#164db3;font-size:13px;font-weight:650}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}.card{border:1px solid #dce3ed;border-radius:14px;background:white;padding:22px;margin-bottom:18px}.stat{font-size:30px;font-weight:700;letter-spacing:-1px;margin:8px 0}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin-top:12px}label{display:grid;gap:5px;font-size:13px;color:#53637a;flex:1;min-width:110px}input,select,button{font:inherit;border-radius:8px;border:1px solid #cbd5e1;padding:10px;background:white;color:#17243c;max-width:100%}button{cursor:pointer;background:#184ed5;color:white;border-color:#184ed5;font-size:13px;font-weight:650}button.secondary{background:white;color:#184ed5;border-color:#cbd5e1}button:disabled{opacity:.5;cursor:wait}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:12px 8px;border-bottom:1px solid #e6ebf2;vertical-align:top}th{color:#64748b;font-size:12px}.scroll{overflow-x:auto}a{color:#164db3}details{margin-top:14px}pre{font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.error{background:#fff1f0;color:#9f1c14;padding:12px;border-radius:8px;margin-bottom:16px}.success{background:#effaf3;color:#166534;padding:12px;border-radius:8px;margin-bottom:16px}ul{padding-left:20px;margin:10px 0}section{margin-top:20px}@media(max-width:640px){header{align-items:start;flex-direction:column}.card{padding:16px}h1{font-size:25px}}`;
/** Framework-neutral portal. Admin controls are only presentation; authorize every route on the server. */
export async function mountBillingPortal(options: {
  element: HTMLElement;
  client: BillingClient;
  subscriptionId: string;
  admin?: boolean;
  title?: string;
  onChange?: (subscription: Subscription) => void | Promise<void>;
}) {
  const doc = options.element.ownerDocument,
    root =
      options.element.shadowRoot ??
      options.element.attachShadow({ mode: "open" });
  const client = options.client,
    id = options.subscriptionId;
  let destroyed = false,
    busy = false,
    message = "",
    failure = false;
  function node<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text?: string,
    className?: string,
  ) {
    const el = doc.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function input(label: string, value = "", type = "text") {
    const wrap = node("label", label),
      field = node("input");
    field.type = type;
    field.value = value;
    wrap.append(field);
    return { wrap, field };
  }
  function select(
    label: string,
    values: { value: string; label: string }[],
    value?: string,
  ) {
    const wrap = node("label", label),
      field = node("select");
    for (const item of values) {
      const opt = node("option", item.label);
      opt.value = item.value;
      field.append(opt);
    }
    if (value) field.value = value;
    wrap.append(field);
    return { wrap, field };
  }
  async function run(action: () => Promise<unknown>) {
    if (busy || destroyed) return;
    busy = true;
    root.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await action();
      message = "Changes saved.";
      failure = false;
    } catch (e) {
      message = e instanceof Error ? e.message : "Billing operation failed";
      failure = true;
    } finally {
      busy = false;
      await refresh();
    }
  }
  function button(
    label: string,
    action: () => Promise<unknown>,
    secondary = false,
  ) {
    const b = node("button", label, secondary ? "secondary" : "");
    b.type = "button";
    b.addEventListener("click", () => void run(action));
    return b;
  }
  function card(title: string) {
    const el = node("section", undefined, "card");
    el.append(node("h2", title));
    return el;
  }
  function operationId() {
    return globalThis.crypto.randomUUID();
  }
  async function refresh() {
    if (destroyed) return;
    let s: Subscription,
      catalog: Awaited<ReturnType<BillingClient["getCatalog"]>>;
    try {
      [s, catalog] = await Promise.all([
        client.getSubscription(id),
        client.getCatalog(id),
      ]);
    } catch (e) {
      root.replaceChildren(
        node(
          "p",
          e instanceof Error ? e.message : "Unable to load billing",
          "error",
        ),
      );
      return;
    }
    if (destroyed) return;
    const style = node("style", css),
      content = node("div");
    root.replaceChildren(style, content);
    const currencyDigits = catalog.currencies[s.price.currency] ?? 2;
    const money = (amount: number) =>
      `${s.price.currency} ${(amount / 10 ** currencyDigits).toLocaleString(undefined, { minimumFractionDigits: currencyDigits, maximumFractionDigits: currencyDigits })}`;
    const header = node("header"),
      intro = node("div");
    intro.append(
      node(
        "p",
        options.admin ? "BILLING OPERATIONS" : "YOUR SUBSCRIPTION",
        "muted",
      ),
      node("h1", options.title ?? "Billing & subscription"),
    );
    header.append(
      intro,
      button("Refresh", async () => {}, true),
    );
    content.append(header);
    if (message)
      content.append(node("p", message, failure ? "error" : "success"));
    const grid = node("div", undefined, "grid"),
      summary = card("Current plan");
    summary.append(
      node("span", s.status.replaceAll("_", " "), "badge"),
      node("p", s.price.name, "stat"),
      node(
        "p",
        `Quantity: ${s.quantity} · Next boundary: ${new Date(s.nextBillingAt).toLocaleDateString()}`,
        "muted",
      ),
    );
    if (s.pendingChange)
      summary.append(
        node("p", `Scheduled plan: ${s.pendingChange.price.name}`, "muted"),
      );
    if (s.cancelAtPeriodEnd)
      summary.append(
        node("p", "Cancellation scheduled at the period boundary.", "muted"),
      );
    if (s.pauseAtPeriodEnd)
      summary.append(
        node("p", "Pause scheduled at the period boundary.", "muted"),
      );
    const actions = node("div", undefined, "row");
    actions.append(
      button("Retry payment", () => client.retryPayment(id)),
      button(
        "Pause next cycle",
        () => client.pauseSubscription(id, { operationId: operationId() }),
        true,
      ),
      button(
        "Resume",
        () => client.resumeSubscription(id, operationId()),
        true,
      ),
    );
    if (s.status === "cancelled")
      actions.append(
        button("Reactivate", () =>
          client.reactivateSubscription(id, operationId()),
        ),
      );
    else
      actions.append(
        button(
          "Cancel next cycle",
          () => client.cancelSubscription(id, { operationId: operationId() }),
          true,
        ),
      );
    summary.append(actions);
    grid.append(summary);
    const account = card("Account");
    account.append(
      node("p", money(s.creditBalance), "stat"),
      node("p", "Available billing credit", "muted"),
      node("p", `Customer: ${s.customerId}`),
      node("p", `Provider: ${s.providerId}`),
      node("p", s.paymentMethod?.label ?? "No saved payment method"),
    );
    const f = node("ul");
    for (const [name, value] of Object.entries(s.price.features))
      f.append(
        node(
          "li",
          `${name.replaceAll("_", " ")}: ${value === true ? "included" : value === false ? "not included" : value}`,
        ),
      );
    account.append(f);
    grid.append(account);
    content.append(grid);
    const plan = card("Change plan"),
      row = node("div", undefined, "row");
    const planSelect = select(
      "Plan",
      catalog.prices
        .filter((p) => p.currency === s.price.currency && p.kind !== "addon")
        .map((p) => ({ value: p.id, label: `${p.name} — ${money(p.amount)}` })),
      s.price.id,
    );
    const quantity = input("Quantity", String(s.quantity), "number"),
      timing = select("When", [
        { value: "next_cycle", label: "Next renewal" },
        { value: "immediate", label: "Immediately (prorated)" },
      ]);
    const addon = select("Add-on", [
      { value: "", label: "Keep current add-ons" },
      { value: "none", label: "Remove add-ons" },
      ...catalog.prices
        .filter((p) => p.currency === s.price.currency && p.kind === "addon")
        .map((p) => ({ value: p.id, label: p.name })),
    ]);
    row.append(
      planSelect.wrap,
      quantity.wrap,
      timing.wrap,
      addon.wrap,
      button("Update plan", () =>
        client.changeSubscription(id, {
          operationId: operationId(),
          priceId: planSelect.field.value,
          quantity: Number(quantity.field.value),
          effective: timing.field.value as "immediate" | "next_cycle",
          ...(addon.field.value
            ? {
                addons:
                  addon.field.value === "none"
                    ? []
                    : [{ priceId: addon.field.value, quantity: 1 }],
              }
            : {}),
        }),
      ),
    );
    plan.append(
      row,
      node(
        "p",
        "Immediate upgrades are granted after payment; unused time on a downgrade becomes account credit.",
        "muted",
      ),
    );
    content.append(plan);
    const payment = card("Payment method"),
      pr = node("div", undefined, "row");
    const provider = select(
        "Provider",
        catalog.providers
          .filter((p) => p.capabilities.currencies.includes(s.price.currency))
          .map((p) => ({ value: p.id, label: p.id })),
        s.providerId,
      ),
      token = input("Provider method token (optional)");
    pr.append(
      provider.wrap,
      token.wrap,
      button("Save payment method", () =>
        client.setPaymentMethod(id, {
          operationId: operationId(),
          providerId: provider.field.value,
          ...(token.field.value ? { token: token.field.value } : {}),
        }),
      ),
    );
    payment.append(
      pr,
      node(
        "p",
        "Use an opaque token created by your provider’s secure setup flow. Never enter card details here.",
        "muted",
      ),
    );
    content.append(payment);
    const history = card("Invoices & receipts"),
      scroll = node("div", undefined, "scroll"),
      table = node("table"),
      head = node("tr");
    for (const title of [
      "Invoice",
      "Description",
      "Amount",
      "Status",
      "Documents",
    ])
      head.append(node("th", title));
    const thead = node("thead");
    thead.append(head);
    table.append(thead);
    const tbody = node("tbody");
    for (const c of [...s.charges].reverse()) {
      const tr = node("tr");
      tr.append(
        node("td", c.number),
        node("td", c.description),
        node("td", money(c.amount)),
        node("td", c.status),
      );
      const links = node("td"),
        a = node("a", "Invoice");
      a.href = client.invoiceUrl(id, c.id);
      a.target = "_blank";
      a.rel = "noopener";
      links.append(a);
      if (c.status === "paid") {
        const receipt = node("a", " · Receipt");
        receipt.href = client.invoiceUrl(id, c.id, true);
        receipt.target = "_blank";
        receipt.rel = "noopener";
        links.append(receipt);
      }
      const latest = c.attempts.at(-1);
      if (latest?.paymentUrl) {
        const pay = node("a", " · Complete payment");
        const url = new URL(latest.paymentUrl);
        if (url.protocol === "https:") {
          pay.href = url.href;
          pay.target = "_blank";
          pay.rel = "noopener";
          links.append(pay);
        }
      }
      tr.append(links);
      tbody.append(tr);
    }
    table.append(tbody);
    scroll.append(table);
    history.append(scroll);
    if (!s.charges.length)
      history.append(
        node(
          "p",
          "Your first invoice will appear when the trial ends.",
          "muted",
        ),
      );
    content.append(history);
    const meterEntries = Object.entries(s.price.meters ?? {});
    if (meterEntries.length) {
      const usage = card("Usage & prepaid units");
      for (const [name, m] of meterEntries) {
        const used = s.usage
          .filter(
            (r) =>
              r.meter === name &&
              r.periodStart === (s.currentPeriodStart ?? s.createdAt),
          )
          .reduce((sum, r) => sum + r.quantity, 0);
        usage.append(
          node(
            "p",
            `${name}: ${used} used · ${m.included * s.quantity} included · ${s.prepaid[name] ?? 0} purchased units remaining`,
          ),
        );
        if (m.mode === "prepaid") {
          const r = node("div", undefined, "row"),
            units = input("Units to buy", "10", "number");
          r.append(
            units.wrap,
            button("Buy units", () =>
              client.buyCredits(id, {
                operationId: operationId(),
                meter: name,
                quantity: Number(units.field.value),
              }),
            ),
          );
          usage.append(r);
        }
      }
      content.append(usage);
    }
    if (options.admin) {
      const admin = card("Administration"),
        r = node("div", undefined, "row"),
        amount = input("Amount in minor units", "1000", "number"),
        reason = input("Reason", "Customer adjustment");
      r.append(
        amount.wrap,
        reason.wrap,
        button("Issue account credit", () =>
          client.issueCredit(id, {
            operationId: operationId(),
            amount: Number(amount.field.value),
            reason: reason.field.value,
          }),
        ),
      );
      admin.append(r);
      if (s.charges.length) {
        const ar = node("div", undefined, "row"),
          inv = select(
            "Invoice",
            s.charges.map((c) => ({
              value: c.id,
              label: `${c.number} (${c.status})`,
            })),
          );
        ar.append(
          inv.wrap,
          button(
            "Refund amount",
            () =>
              client.refund(id, {
                operationId: operationId(),
                chargeId: inv.field.value,
                amount: Number(amount.field.value),
                reason: reason.field.value,
              }),
            true,
          ),
          button(
            "Void unpaid invoice",
            () =>
              client.voidInvoice(id, {
                operationId: operationId(),
                chargeId: inv.field.value,
                reason: reason.field.value,
              }),
            true,
          ),
        );
        admin.append(ar);
      }
      if (meterEntries.length) {
        const ur = node("div", undefined, "row"),
          meter = select(
            "Usage meter",
            meterEntries.map(([name]) => ({ value: name, label: name })),
          ),
          units = input("Units consumed", "1", "number");
        ur.append(
          meter.wrap,
          units.wrap,
          button("Record usage", () =>
            client.recordUsage(id, {
              operationId: operationId(),
              meter: meter.field.value,
              quantity: Number(units.field.value),
            }),
          ),
        );
        admin.append(ur);
      }
      const exportLink = node("a", "Export billing state");
      exportLink.href = client.exportUrl(id);
      admin.append(
        node(
          "p",
          "Credit/refund actions require a server-authorized operator identity.",
          "muted",
        ),
        exportLink,
      );
      const details = node("details"),
        summary = node("summary", "Audit trail, attempts & refunds");
      details.append(
        summary,
        node(
          "pre",
          JSON.stringify(
            {
              attempts: s.charges.map((c) => ({
                invoice: c.number,
                attempts: c.attempts,
              })),
              refunds: s.refunds,
              events: s.events,
            },
            null,
            2,
          ),
        ),
      );
      admin.append(details);
      content.append(admin);
    }
    await options.onChange?.(s);
  }
  await refresh();
  return {
    refresh,
    destroy: () => {
      destroyed = true;
      root.replaceChildren();
    },
  };
}
