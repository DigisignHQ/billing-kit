import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  createBilling,
  createBillingHandler,
  createProviderWebhookHandler,
} from "../src/server.js";
import { limitedText } from "../src/http.js";
import { memoryStorage } from "../src/adapters/memory.js";
import { sandboxClock, sandboxProvider } from "../src/adapters/sandbox.js";
const clock = sandboxClock(),
  wallet = sandboxProvider({ id: "sandbox_wallet", clock: clock.now }),
  links = sandboxProvider({
    id: "sandbox_links",
    mode: "links",
    clock: clock.now,
  });
wallet.registerPaymentMethod("acme");
links.registerPaymentMethod("acme");
const billing = createBilling({
  namespace: "local-demo",
  storage: memoryStorage(),
  providers: [wallet, links],
  clock: clock.now,
  coupons: [{ id: "welcome", percentBps: 2000, cycles: 1 }],
  prices: [
    {
      id: "starter",
      planId: "starter",
      name: "Starter",
      amount: 500000,
      currency: "NGN",
      intervalMonths: 1,
      features: { offline_signing: true, team_members: 3 },
      meters: {
        verification: { mode: "metered", included: 10, unitAmount: 1000 },
        messages: { mode: "prepaid", included: 5, unitAmount: 500 },
      },
    },
    {
      id: "business",
      planId: "business",
      name: "Business",
      amount: 1000000,
      currency: "NGN",
      intervalMonths: 1,
      features: {
        offline_signing: true,
        whatsapp_signing: true,
        sso: true,
        team_members: 10,
      },
      meters: {
        verification: { mode: "metered", included: 10, unitAmount: 1000 },
        messages: { mode: "prepaid", included: 5, unitAmount: 500 },
      },
    },
    {
      kind: "addon",
      id: "support",
      planId: "support",
      name: "Priority support add-on",
      amount: 100000,
      currency: "NGN",
      intervalMonths: 1,
      features: { priority_support: true },
    },
  ],
});
await billing.subscriptions.create({
  id: "acme_subscription",
  customerId: "acme",
  priceId: "starter",
  trialDays: 14,
  couponId: "welcome",
});
const token = randomBytes(24).toString("hex"),
  port = Number(process.env.BILLING_KIT_DEMO_PORT ?? 4318),
  origin = `http://127.0.0.1:${port}`;
const auth = (request: Request) =>
  request.headers
    .get("cookie")
    ?.split(";")
    .some((x) => x.trim() === `billing_demo=${token}`) === true;
const safeWrite = (request: Request) =>
  auth(request) && request.headers.get("x-demo-csrf") === token;
const handler = createBillingHandler({
  billing,
  issuer: "DigiSign Billing Kit — sandbox",
  authorize: async ({ request, subscriptionId }) => ({
    allowed:
      subscriptionId === "acme_subscription" &&
      auth(request) &&
      (request.method === "GET" || safeWrite(request)),
    actor: "demo_operator",
  }),
});
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Billing Kit · Local sandbox</title><style>
body{background:#f3f6fb;color:#17243c;font:15px system-ui;margin:0}.shell{max-width:1180px;margin:auto;padding:32px 24px}.brand{font-weight:750;font-size:18px;letter-spacing:-.5px;margin-bottom:22px}.sandbox{background:#152849;color:white;padding:22px;border-radius:14px;margin-bottom:24px}.sandbox h2{font-size:18px;margin:0 0 6px}.sandbox p{color:#c3d2ec;font-size:13px}.buttons{display:flex;gap:8px;flex-wrap:wrap}button{font:13px system-ui;padding:10px 13px;border:1px solid #8297bd;border-radius:8px;background:#24477a;color:white;cursor:pointer}button:disabled{opacity:.5}#demo-status{min-height:20px}footer{color:#62718a;font-size:12px;margin-top:20px}</style></head><body><main class="shell"><div class="brand">DigiSign / Billing Kit</div><section class="sandbox"><h2>Local sandbox</h2><p>No real payments. All data resets when the server restarts. Prices are examples.</p><p id="clock"></p><div class="buttons"><button data-action="advance" data-days="14">Advance 14 days</button><button data-action="advance" data-days="1">Advance 1 day</button><button data-action="topup">Add NGN 50,000 to sandbox wallet</button><button data-action="renew">Run billing sweep</button><button data-action="fail">Simulate next payment failure</button><button data-action="complete">Confirm sandbox payment link</button><button id="mode">Switch customer / admin view</button></div><p id="demo-status" role="status"></p></section><div id="portal"></div><footer>Development example. Authentication is local-demo only; use your own identity, authorization and provider adapter in an application.</footer></main>
<script type="module">
import {createBillingClient} from '/assets/client.js';import {mountBillingPortal} from '/assets/portal.js';
const client=createBillingClient({baseUrl:'/api/billing',headers:()=>({'x-demo-csrf':'${token}'})});let admin=false;
let portal=await mountBillingPortal({element:document.querySelector('#portal'),client,subscriptionId:'acme_subscription',admin,onChange:()=>state()});
async function state(){const r=await fetch('/demo/state');const s=await r.json();document.querySelector('#clock').textContent='Clock: '+s.time+' · '+s.providerId+' balance: NGN '+(s.balance/100).toLocaleString();}
await state();
document.querySelector('#mode').onclick=async()=>{admin=!admin;portal.destroy();portal=await mountBillingPortal({element:document.querySelector('#portal'),client,subscriptionId:'acme_subscription',admin,onChange:()=>state()});};
for(const button of document.querySelectorAll('[data-action]'))button.onclick=async()=>{button.disabled=true;try{const r=await fetch('/demo/action',{method:'POST',headers:{'content-type':'application/json','x-demo-csrf':'${token}'},body:JSON.stringify({action:button.dataset.action,days:Number(button.dataset.days??0)})});const value=await r.json();document.querySelector('#demo-status').textContent=value.message??value.error;await portal.refresh();await state();}finally{button.disabled=false;}};
</script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(403);
      res.end();
      return;
    }
    const request = new Request(new URL(req.url ?? "/", origin), {
      method: req.method,
      headers: req.headers as HeadersInit,
      ...(req.method !== "GET" && req.method !== "HEAD"
        ? { body: req as any, duplex: "half" }
        : {}),
    } as RequestInit);
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname === "/" && request.method === "GET")
      response = new Response(page, {
        headers: {
          "content-type": "text/html",
          "set-cookie": `billing_demo=${token}; HttpOnly; SameSite=Strict; Path=/`,
          "cache-control": "no-store",
        },
      });
    else if (["/assets/client.js", "/assets/portal.js"].includes(url.pathname))
      response = new Response(
        await readFile(
          new URL(`../dist/${url.pathname.split("/").at(-1)}`, import.meta.url),
          "utf8",
        ),
        { headers: { "content-type": "text/javascript" } },
      );
    else if (url.pathname === "/demo/state" && auth(request))
      response = await (async () => {
        const s = await billing.subscriptions.get("acme_subscription");
        return Response.json({
          time: clock.now().toISOString(),
          providerId: s.providerId,
          balance: (s.providerId === "sandbox_links" ? links : wallet).balance(
            "acme",
          ),
        });
      })();
    else if (
      url.pathname === "/demo/action" &&
      request.method === "POST" &&
      safeWrite(request)
    ) {
      const body = JSON.parse(await limitedText(request, 1024));
      if (body.action === "advance") {
        if (![1, 14].includes(body.days))
          throw new Error("Invalid clock advance");
        clock.advance(body.days);
      } else if (body.action === "topup") {
        wallet.topUp("acme", 5000000);
        links.topUp("acme", 5000000);
      } else if (body.action === "fail") {
        wallet.failNext("decline");
        links.failNext("decline");
      } else if (body.action === "complete") {
        const s = await billing.subscriptions.get("acme_subscription"),
          a = s.charges
            .flatMap((c) => c.attempts)
            .find((a) => a.status === "requires_action");
        if (!a) throw new Error("No pending payment link");
        const provider = a.providerId === "sandbox_links" ? links : wallet;
        provider.completePayment(a.key);
        await billing.handleWebhook(
          provider.id,
          provider.webhook(a.key, `event_${s.version}`),
        );
      } else if (body.action !== "renew")
        throw new Error("Unknown demo action");
      if (body.action === "advance" || body.action === "renew")
        await billing.processDueRenewals();
      await billing.dispatchEvents("acme_subscription", async (event) => {
        console.log("Event:", event.type);
      });
      response = Response.json({ message: "Sandbox action completed." });
    } else if (url.pathname.startsWith("/api/billing/"))
      response = await handler(request);
    else if (url.pathname === "/webhooks/sandbox_links")
      response = await createProviderWebhookHandler(
        billing,
        "sandbox_links",
      )(request);
    else response = new Response(null, { status: 404 });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: e instanceof Error ? e.message : "Request failed",
      }),
    );
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Billing Kit sandbox: ${origin}\nCtrl+C to stop. No live payments or external databases are used.`,
  ),
);
