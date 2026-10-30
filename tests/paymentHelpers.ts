import type { InitializeInput, PaymentGateway, VerifyResult } from "../src/services/payments/PaymentGateway.js";
import { setPaymentGateway } from "../src/services/payments/index.js";
import { computeSignature } from "../src/services/payments/signature.js";
import { Order } from "../src/models/Order.js";
import { SubOrder } from "../src/models/SubOrder.js";
import { IBADAN, OJA_BA, api, createCustomer, createProduct, createVendor, fakeDistance } from "./helpers.js";

export const WEBHOOK_SECRET = "test-paystack-secret";

/** A controllable stand-in for Paystack. By default it confirms exactly the amount it was asked to charge. */
export class FakeGateway implements PaymentGateway {
  inits: InitializeInput[] = [];
  verifies: string[] = [];
  results = new Map<string, Partial<VerifyResult> | null>();
  failInit: Error | null = null;
  failVerify: Error | null = null;

  reset() {
    this.inits = [];
    this.verifies = [];
    this.results.clear();
    this.failInit = null;
    this.failVerify = null;
  }
  async initialize(input: InitializeInput) {
    this.inits.push(input);
    if (this.failInit) throw this.failInit;
    return { authorizationUrl: `https://paystack.test/pay/${input.reference}` };
  }
  async verify(reference: string): Promise<VerifyResult | null> {
    this.verifies.push(reference);
    if (this.failVerify) throw this.failVerify;
    if (this.results.has(reference)) {
      const r = this.results.get(reference);
      if (r === null) return null;
      const init = this.inits.find((i) => i.reference === reference);
      return { reference, status: "success", amountKobo: init?.amountKobo ?? 0, currency: "NGN", paystackId: "9001", channel: "card", paidAt: new Date(), ...r };
    }
    const init = this.inits.find((i) => i.reference === reference);
    if (!init) return null;
    return { reference, status: "success", amountKobo: init.amountKobo, currency: "NGN", paystackId: "9001", channel: "card", paidAt: new Date() };
  }
}

export const fakeGateway = new FakeGateway();
setPaymentGateway(fakeGateway, WEBHOOK_SECRET);

/** Sends a webhook exactly as Paystack would: raw JSON body plus an HMAC-SHA512 signature header. */
export function sendWebhook(payload: object | string, opts: { secret?: string; signature?: string | null } = {}) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signature = opts.signature === undefined ? computeSignature(raw, opts.secret ?? WEBHOOK_SECRET) : opts.signature;
  let req = api().post("/api/webhooks/paystack").set("Content-Type", "application/json");
  if (signature !== null) req = req.set("x-paystack-signature", signature);
  return req.send(raw);
}

export const chargeSuccess = (reference: string, extra: Record<string, unknown> = {}) => ({
  event: "charge.success",
  data: { reference, status: "success", amount: 0, currency: "NGN", ...extra },
});

/** The checkout screen scenario: two vendors in Ibadan at 3.2 km and 6.4 km, bean flour N15,000 and palm oil N15,300. */
export async function twoVendorScenario() {
  const bodija = await createVendor({ name: "Bodija Provisions", point: IBADAN });
  const ojaba = await createVendor({ name: "Oja'ba Foodstuff", point: OJA_BA });
  const flour = await createProduct(bodija.vendor, { name: "Omosalewa Bean Flour", priceKobo: 1500000, stock: 10 });
  const oil = await createProduct(ojaba.vendor, { name: "Banga Palm Oil, 4L", priceKobo: 1530000, stock: 10 });
  fakeDistance.setFrom(IBADAN, 3200);
  fakeDistance.setFrom(OJA_BA, 6400);
  const customer = await createCustomer();
  const items = [{ productId: String(flour._id), qty: 1 }, { productId: String(oil._id), qty: 1 }];
  return { bodija, ojaba, flour, oil, customer, items };
}

export const placeOrderReq = (bearer: string, body: unknown) => api().post("/api/checkout").set("Authorization", bearer).send(body as object);

/** Places an order through the real endpoint and returns its API data plus the stored documents. */
export async function placeOrder(customer: { bearer: string; address: { _id: unknown } }, items: { productId: string; qty: number }[]) {
  const res = await placeOrderReq(customer.bearer, { items, addressId: String(customer.address._id) });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  const data = res.body.data as { orderId: string; orderNumber: string; reference: string; totalKobo: number; authorizationUrl: string; expiresAt: string };
  const order = (await Order.findById(data.orderId))!;
  const subs = await SubOrder.find({ orderId: order._id }).sort({ ref: 1 });
  return { data, order, subs };
}
