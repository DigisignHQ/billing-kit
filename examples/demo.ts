import { createBilling } from "../src/server.js";
import { memoryStorage, memoryWallet } from "../src/adapters/memory.js";
let time = new Date("2026-01-01T09:00:00Z");
const wallet = memoryWallet({ acme: 0 });
const billing = createBilling({
  storage: memoryStorage(),
  payments: wallet,
  namespace: "digisign-sandbox",
  clock: () => time,
  prices: [
    {
      id: "starter_monthly_v1",
      planId: "starter",
      name: "Starter (example price)",
      amount: 500000,
      currency: "NGN",
      intervalMonths: 1,
      features: { whatsapp_signing: true, team_members: 5 },
    },
  ],
});
await billing.subscriptions.create({
  id: "acme_starter",
  customerId: "acme",
  priceId: "starter_monthly_v1",
  trialDays: 14,
});
time = new Date("2026-01-12T09:00:00Z");
await billing.processDueRenewals();
time = new Date("2026-01-15T09:00:00Z");
await billing.processDueRenewals();
console.log(
  "Empty wallet:",
  (await billing.subscriptions.get("acme_starter")).status,
);
wallet.topUp("acme", 1000000);
await billing.retryPayment("acme_starter");
console.log(
  "After top-up:",
  (await billing.subscriptions.get("acme_starter")).status,
);
console.log("Balance (kobo):", wallet.balance("acme"));
console.log("History:", await billing.history("acme_starter"));
await billing.dispatchEvents("acme_starter", async (event) => {
  console.log("Notification:", event.type, event.data);
});
