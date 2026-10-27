import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Order } from "../src/models/Order.js";
import { Product } from "../src/models/Product.js";
import { StatusLog } from "../src/models/StatusLog.js";
import { SubOrder } from "../src/models/SubOrder.js";
import { WebhookEvent } from "../src/models/WebhookEvent.js";
import { cancelPendingOrder, expireStaleOrders } from "../src/modules/orders/orders.service.js";
import { DevGateway } from "../src/services/payments/DevGateway.js";
import { DEV_WEBHOOK_SECRET, setPaymentGateway } from "../src/services/payments/index.js";
import { AppError } from "../src/utils/AppError.js";
import { XRW, api, clearDb, fakeDistance, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { WEBHOOK_SECRET, chargeSuccess, fakeGateway, placeOrder, sendWebhook, twoVendorScenario } from "./paymentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  fakeDistance.reset();
  fakeGateway.reset();
});

async function pending() {
  const s = await twoVendorScenario();
  const placed = await placeOrder(s.customer, s.items);
  return { ...s, ...placed };
}
const outcomeOf = (res: { body: { data?: { outcome?: string } } }) => res.body.data?.outcome;

describe("signature check", () => {
  it("rejects a missing, wrong or tampered signature with 401 and changes nothing", async () => {
    const { data, order } = await pending();
    const payload = chargeSuccess(data.reference);
    const raw = JSON.stringify(payload);

    expect((await sendWebhook(payload, { signature: null })).status).toBe(401);
    expect((await sendWebhook(payload, { secret: "sk_test_someone_else" })).status).toBe(401);
    expect((await sendWebhook(payload, { signature: "0".repeat(128) })).status).toBe(401);
    // Valid signature for a different body
    const other = (await import("../src/services/payments/signature.js")).computeSignature(raw.replace(data.reference, "VM-1-X"), WEBHOOK_SECRET);
    expect((await sendWebhook(raw, { signature: other })).status).toBe(401);

    expect((await Order.findById(order._id))!.status).toBe("PENDING_PAYMENT");
    expect(fakeGateway.verifies).toHaveLength(0); // we did not even call Paystack for an unauthentic request
    expect(await WebhookEvent.countDocuments()).toBe(0);
  });

  it("verifies the signature over the exact raw bytes, not a re-serialised copy", async () => {
    const { data, order } = await pending();
    // Unusual spacing and key order: only the raw body hashes to the signature.
    const raw = `{ "data" : { "reference" : "${data.reference}", "status":"success" } ,\n "event":"charge.success" }`;
    const res = await sendWebhook(raw);
    expect(res.status).toBe(200);
    expect(outcomeOf(res)).toBe("PAID");
    expect((await Order.findById(order._id))!.status).toBe("PAID");
  });

  it("needs no cookie or CSRF header", async () => {
    const { data } = await pending();
    const res = await sendWebhook(chargeSuccess(data.reference)); // no X-Requested-With, no session
    expect(res.status).toBe(200);
  });
});

describe("a genuine successful payment", () => {
  it("verifies with Paystack, then marks the order and every sub-order PAID", async () => {
    const { data, order, subs, flour, oil } = await pending();
    const res = await sendWebhook(chargeSuccess(data.reference));
    expect(res.status).toBe(200);
    expect(outcomeOf(res)).toBe("PAID");

    // The server asked Paystack itself rather than believing the payload.
    expect(fakeGateway.verifies).toEqual([data.reference]);

    const paid = (await Order.findById(order._id))!;
    expect(paid.status).toBe("PAID");
    expect(paid.payment).toMatchObject({ paystackId: "9001", channel: "card" });
    expect(paid.payment!.paidAt).toBeInstanceOf(Date);

    const after = await SubOrder.find({ orderId: order._id });
    expect(after.map((s) => s.status)).toEqual(["PAID", "PAID"]);
    expect(after.every((s) => s.paidAt)).toBe(true);
    expect(after.map((s) => String(s._id)).sort()).toEqual(subs.map((s) => String(s._id)).sort());

    // Sale counts feed "best sellers".
    expect((await Product.findById(flour._id))!.soldCount).toBe(1);
    expect((await Product.findById(oil._id))!.soldCount).toBe(1);
    // Stock stays taken (it was reserved at checkout).
    expect((await Product.findById(flour._id))!.stock).toBe(9);
  });

  it("logs each sub-order PENDING_PAYMENT to PAID as the system", async () => {
    const { data, order } = await pending();
    await sendWebhook(chargeSuccess(data.reference));
    const logs = await StatusLog.find({ orderId: order._id, to: "PAID" });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ from: "PENDING_PAYMENT", actorRole: "SYSTEM", note: "Payment confirmed" });
    expect(logs[0]!.actorId).toBeUndefined();
  });

  it("records the event so a replay can be recognised", async () => {
    const { data } = await pending();
    await sendWebhook(chargeSuccess(data.reference));
    const row = (await WebhookEvent.findOne({ reference: data.reference }))!;
    expect(row).toMatchObject({ eventKey: `charge.success:${data.reference}`, type: "charge.success", outcome: "PAID" });
    expect(row.processedAt).toBeInstanceOf(Date);
  });
});

describe("idempotency", () => {
  it("treats a replay as a no-op: same final state, no second set of side effects", async () => {
    const { data, order, flour } = await pending();
    const first = await sendWebhook(chargeSuccess(data.reference));
    const second = await sendWebhook(chargeSuccess(data.reference));
    const third = await sendWebhook(chargeSuccess(data.reference));
    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    expect([outcomeOf(first), outcomeOf(second), outcomeOf(third)]).toEqual(["PAID", "DUPLICATE", "DUPLICATE"]);

    expect(fakeGateway.verifies).toHaveLength(1); // duplicates do not even call Paystack again
    expect(await WebhookEvent.countDocuments({ reference: data.reference })).toBe(1);
    expect(await StatusLog.countDocuments({ orderId: order._id, to: "PAID" })).toBe(2); // two sub-orders, logged once each
    expect((await Product.findById(flour._id))!.soldCount).toBe(1);
  });

  it("survives ten simultaneous deliveries of the same event: one wins, nothing is counted twice", async () => {
    const { data, order, flour, oil } = await pending();
    const results = await Promise.all(Array.from({ length: 10 }, () => sendWebhook(chargeSuccess(data.reference))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const outcomes = results.map(outcomeOf);
    expect(outcomes.filter((o) => o === "PAID")).toHaveLength(1);
    expect(outcomes.every((o) => ["PAID", "DUPLICATE", "ALREADY_PAID"].includes(o as string))).toBe(true);

    expect((await Order.findById(order._id))!.status).toBe("PAID");
    expect(await StatusLog.countDocuments({ orderId: order._id, to: "PAID" })).toBe(2);
    expect((await Product.findById(flour._id))!.soldCount).toBe(1);
    expect((await Product.findById(oil._id))!.soldCount).toBe(1);
    expect(await WebhookEvent.countDocuments({ reference: data.reference })).toBe(1);
  });

  it("does not let a second order be paid by the first one's reference", async () => {
    const s = await twoVendorScenario();
    const a = await placeOrder(s.customer, s.items);
    const b = await placeOrder(s.customer, s.items);
    await sendWebhook(chargeSuccess(a.data.reference));
    expect((await Order.findById(a.order._id))!.status).toBe("PAID");
    expect((await Order.findById(b.order._id))!.status).toBe("PENDING_PAYMENT");
  });

  it("repairs an order that was marked paid but whose sub-orders were not updated (a crash halfway)", async () => {
    const { data, order, flour } = await pending();
    // Simulate the process dying after the order update but before the sub-order update.
    await Order.updateOne({ _id: order._id }, { status: "PAID", "payment.paidAt": new Date() });
    expect((await SubOrder.find({ orderId: order._id })).map((s) => s.status)).toEqual(["PENDING_PAYMENT", "PENDING_PAYMENT"]);

    const res = await sendWebhook(chargeSuccess(data.reference));
    expect(outcomeOf(res)).toBe("ALREADY_PAID");
    expect((await SubOrder.find({ orderId: order._id })).map((s) => s.status)).toEqual(["PAID", "PAID"]);
    expect((await Product.findById(flour._id))!.soldCount).toBe(1);

    await sendWebhook(chargeSuccess(data.reference)); // and again: still only once
    expect((await Product.findById(flour._id))!.soldCount).toBe(1);
  });

  it("lets Paystack's retry succeed after a transient failure, without losing the payment", async () => {
    const { data, order } = await pending();
    fakeGateway.failVerify = AppError.unavailable("Paystack is down");
    const failed = await sendWebhook(chargeSuccess(data.reference));
    expect(failed.status).toBe(503); // non-2xx, so Paystack will retry
    expect((await Order.findById(order._id))!.status).toBe("PENDING_PAYMENT");
    expect((await WebhookEvent.findOne({ reference: data.reference }))!.processedAt).toBeUndefined();

    fakeGateway.failVerify = null;
    const retried = await sendWebhook(chargeSuccess(data.reference));
    expect(outcomeOf(retried)).toBe("PAID");
    expect((await Order.findById(order._id))!.status).toBe("PAID");
  });
});

describe("never trusts the webhook payload", () => {
  it("does not pay an order when Paystack says it did not succeed, whatever the payload claims", async () => {
    const { data, order } = await pending();
    fakeGateway.results.set(data.reference, { status: "failed" });
    const res = await sendWebhook(chargeSuccess(data.reference, { status: "success", amount: 3222000 }));
    expect(outcomeOf(res)).toBe("NOT_SUCCESSFUL");
    expect((await Order.findById(order._id))!.status).toBe("PENDING_PAYMENT");
    expect((await SubOrder.find({ orderId: order._id })).map((s) => s.status)).toEqual(["PENDING_PAYMENT", "PENDING_PAYMENT"]);
  });

  it("does not pay an order when the verified amount is short, and flags it for a human", async () => {
    const { data, order } = await pending();
    fakeGateway.results.set(data.reference, { amountKobo: 3222000 - 1 });
    const res = await sendWebhook(chargeSuccess(data.reference, { amount: 3222000 })); // payload lies
    expect(outcomeOf(res)).toBe("AMOUNT_MISMATCH");
    const after = (await Order.findById(order._id))!;
    expect(after.status).toBe("PENDING_PAYMENT");
    expect(after.needsAttention).toBe(true);
    expect(after.attentionReason).toMatch(/does not match|order total/);
  });

  it("does not pay an order when the verified amount is too high either", async () => {
    const { data, order } = await pending();
    fakeGateway.results.set(data.reference, { amountKobo: 3222001 });
    expect(outcomeOf(await sendWebhook(chargeSuccess(data.reference)))).toBe("AMOUNT_MISMATCH");
    expect((await Order.findById(order._id))!.status).toBe("PENDING_PAYMENT");
  });

  it("does not pay an order when the currency is not NGN", async () => {
    const { data, order } = await pending();
    fakeGateway.results.set(data.reference, { currency: "USD" });
    expect(outcomeOf(await sendWebhook(chargeSuccess(data.reference)))).toBe("AMOUNT_MISMATCH");
    expect((await Order.findById(order._id))!.status).toBe("PENDING_PAYMENT");
  });

  it("does not pay when Paystack does not recognise the reference", async () => {
    const { data, order } = await pending();
    fakeGateway.results.set(data.reference, null);
    expect(outcomeOf(await sendWebhook(chargeSuccess(data.reference)))).toBe("NOT_SUCCESSFUL");
    expect((await Order.findById(order._id))!.status).toBe("PENDING_PAYMENT");
  });

  it("acknowledges a reference we have never issued, without error and without calling Paystack", async () => {
    const res = await sendWebhook(chargeSuccess("VM-99999-DEADBEEF"));
    expect(res.status).toBe(200);
    expect(outcomeOf(res)).toBe("UNKNOWN_REFERENCE");
    expect(fakeGateway.verifies).toHaveLength(0);
  });
});

describe("other events and bad bodies", () => {
  it("acknowledges and ignores events we do not act on", async () => {
    const { data, order } = await pending();
    for (const event of ["charge.failed", "transfer.success", "refund.processed"]) {
      const res = await sendWebhook({ event, data: { reference: data.reference } });
      expect(res.status, event).toBe(200);
      expect(res.body.data).toEqual({ ignored: true });
    }
    expect((await Order.findById(order._id))!.status).toBe("PENDING_PAYMENT");
    expect(fakeGateway.verifies).toHaveLength(0);
  });

  it("rejects a signed but malformed or incomplete body with 400", async () => {
    expect((await sendWebhook("not json at all")).status).toBe(400);
    expect((await sendWebhook({ event: "charge.success", data: {} })).status).toBe(400);
    expect((await sendWebhook({ event: "charge.success", data: { reference: 12345 } })).status).toBe(400);
    expect((await sendWebhook({ event: "charge.success", data: { reference: { $ne: null } } })).status).toBe(400);
    expect((await sendWebhook({ event: "charge.success" })).status).toBe(400);
  });
});

describe("a payment that arrives too late", () => {
  it("keeps an expired order cancelled, flags it for a refund, and pays nobody", async () => {
    const { data, order, flour } = await pending();
    await Order.updateOne({ _id: order._id }, { expiresAt: new Date(Date.now() - 1000) });
    await expireStaleOrders();
    expect((await Order.findById(order._id))!.status).toBe("CANCELLED");
    expect((await Product.findById(flour._id))!.stock).toBe(10);

    const res = await sendWebhook(chargeSuccess(data.reference));
    expect(res.status).toBe(200);
    expect(outcomeOf(res)).toBe("LATE_PAYMENT");

    const after = (await Order.findById(order._id))!;
    expect(after.status).toBe("CANCELLED");
    expect(after.needsAttention).toBe(true);
    expect(after.attentionReason).toMatch(/Refund/);
    expect(after.payment!.paystackId).toBe("9001"); // the money is on record
    expect((await SubOrder.find({ orderId: order._id })).map((s) => s.status)).toEqual(["CANCELLED", "CANCELLED"]);
    expect((await Product.findById(flour._id))!.soldCount).toBe(0);
    expect((await Product.findById(flour._id))!.stock).toBe(10); // stock not taken again
  });

  it("settles a race between expiry and payment so exactly one of them wins", async () => {
    for (let i = 0; i < 5; i++) {
      await clearDb();
      await seedReferenceData();
      fakeGateway.reset();
      const { data, order, flour } = await pending();
      const [cancelled] = await Promise.all([cancelPendingOrder(order._id, "Payment window expired"), sendWebhook(chargeSuccess(data.reference))]);
      const final = (await Order.findById(order._id))!;
      const subs = await SubOrder.find({ orderId: order._id });
      const stock = (await Product.findById(flour._id))!.stock;
      if (final.status === "PAID") {
        expect(cancelled).toBe(false);
        expect(subs.every((s) => s.status === "PAID")).toBe(true);
        expect(stock).toBe(9); // still held for the paid order
      } else {
        expect(final.status).toBe("CANCELLED");
        expect(final.needsAttention).toBe(true); // payment landed after cancel: a human refunds it
        expect(subs.every((s) => s.status === "CANCELLED")).toBe(true);
        expect(stock).toBe(10); // returned exactly once
      }
    }
  });
});

describe("the development gateway (no Paystack key)", () => {
  it("pays through the same signed-webhook path, so the whole flow works without keys", async () => {
    const dev = new DevGateway("http://localhost:3000");
    setPaymentGateway(dev, DEV_WEBHOOK_SECRET);
    try {
      const { data, order, flour } = await pending();
      expect(data.authorizationUrl).toBe(`http://localhost:3000/dev/paystack/?reference=${encodeURIComponent(data.reference)}`);

      const tx = await api().get(`/api/dev/paystack/transaction?reference=${data.reference}`);
      expect(tx.body.data).toMatchObject({ amountKobo: 3222000, status: "pending", orderNumber: "VM-10001" });

      const charge = await api().post("/api/dev/paystack/charge").set(XRW).send({ reference: data.reference, outcome: "success" });
      expect(charge.status).toBe(200);
      expect(charge.body.data).toMatchObject({ webhookStatus: 200, data: { outcome: "PAID" } });
      expect((await Order.findById(order._id))!.status).toBe("PAID");
      expect((await Product.findById(flour._id))!.soldCount).toBe(1);

      // "Paying" twice is the same as a webhook replay.
      const again = await api().post("/api/dev/paystack/charge").set(XRW).send({ reference: data.reference, outcome: "success" });
      expect(again.body.data.data.outcome).toBe("DUPLICATE");
    } finally {
      setPaymentGateway(fakeGateway, WEBHOOK_SECRET);
    }
  });

  it("a failed dev payment leaves the order unpaid", async () => {
    const dev = new DevGateway("http://localhost:3000");
    setPaymentGateway(dev, DEV_WEBHOOK_SECRET);
    try {
      const { data, order } = await pending();
      const res = await api().post("/api/dev/paystack/charge").set(XRW).send({ reference: data.reference, outcome: "failed" });
      expect(res.body.data.outcome).toBe("FAILED");
      expect((await Order.findById(order._id))!.status).toBe("PENDING_PAYMENT");
    } finally {
      setPaymentGateway(fakeGateway, WEBHOOK_SECRET);
    }
  });

  it("is switched off when a real gateway is installed", async () => {
    const res = await api().post("/api/dev/paystack/charge").set(XRW).send({ reference: "VM-10001-AAAAAAAA", outcome: "success" });
    expect(res.status).toBe(404);
    vi.restoreAllMocks();
  });
});
