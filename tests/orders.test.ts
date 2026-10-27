import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Address } from "../src/models/Address.js";
import { Order } from "../src/models/Order.js";
import { Product } from "../src/models/Product.js";
import { Settings } from "../src/models/Settings.js";
import { StatusLog } from "../src/models/StatusLog.js";
import { SubOrder } from "../src/models/SubOrder.js";
import { expireStaleOrders, subOrderLetter } from "../src/modules/orders/orders.service.js";
import { AppError } from "../src/utils/AppError.js";
import { api, clearDb, createCustomer, createProduct, createUser, createVendor, fakeDistance, loginCookie, seedReferenceData, startDb, stopDb, XRW } from "./helpers.js";
import { fakeGateway, placeOrder, placeOrderReq, twoVendorScenario } from "./paymentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  fakeDistance.reset();
  fakeGateway.reset();
});

describe("POST /api/checkout (create order)", () => {
  it("creates one order and one sub-order per vendor, matching the checkout screen to the kobo", async () => {
    const { customer, items } = await twoVendorScenario();
    const { data, order, subs } = await placeOrder(customer, items);

    expect(data.orderNumber).toBe("VM-10001");
    expect(data.totalKobo).toBe(3222000); // N32,220
    expect(data.authorizationUrl).toBe(`https://paystack.test/pay/${data.reference}`);
    expect(data.reference).toMatch(/^VM-10001-[0-9A-F]{8}$/);

    expect(order).toMatchObject({ status: "PENDING_PAYMENT", itemsSubtotalKobo: 3030000, deliveryTotalKobo: 192000, totalKobo: 3222000 });
    expect(order.payment).toMatchObject({ reference: data.reference, amountKobo: 3222000 });

    expect(subs.map((s) => s.ref)).toEqual(["VM-10001-A", "VM-10001-B"]);
    expect(subs.map((s) => s.status)).toEqual(["PENDING_PAYMENT", "PENDING_PAYMENT"]);
    expect(subs.map((s) => s.delivery!.feeKobo).sort((a, b) => a - b)).toEqual([64000, 128000]); // N640 and N1,280
    expect(subs.reduce((n, s) => n + s.delivery!.feeKobo, 0)).toBe(order.deliveryTotalKobo);
    expect(subs.reduce((n, s) => n + s.itemsTotalKobo, 0)).toBe(order.itemsSubtotalKobo);
  });

  it("asks Paystack for exactly the order total in kobo, with the customer's email and a callback carrying the reference", async () => {
    const { customer, items } = await twoVendorScenario();
    const { data, order } = await placeOrder(customer, items);
    expect(fakeGateway.inits).toHaveLength(1);
    expect(fakeGateway.inits[0]).toMatchObject({ amountKobo: order.totalKobo, reference: data.reference, email: customer.email });
    expect(fakeGateway.inits[0]!.callbackUrl).toBe(`http://localhost:3000/checkout/callback/?reference=${encodeURIComponent(data.reference)}`);
    expect(Number.isInteger(fakeGateway.inits[0]!.amountKobo)).toBe(true);
  });

  it("snapshots commission per item and keeps the delivery fee out of vendor earnings", async () => {
    const { customer, items } = await twoVendorScenario();
    const { subs, order } = await placeOrder(customer, items);
    expect(order.pricing).toMatchObject({ pricePerKmKobo: 20000, minDeliveryFeeKobo: null, commissionBps: 1000 });
    for (const s of subs) {
      expect(s.commissionBps).toBe(1000);
      expect(s.commissionTotalKobo + s.vendorEarningKobo).toBe(s.itemsTotalKobo); // goods only
      expect(s.vendorEarningKobo).toBe(s.itemsTotalKobo - Math.round(s.itemsTotalKobo / 10));
      expect(s.items[0]!.vendorEarningKobo + s.items[0]!.commissionKobo).toBe(s.items[0]!.lineTotalKobo);
    }
    const bodijaSub = subs.find((s) => s.items[0]!.name === "Omosalewa Bean Flour")!;
    expect(bodijaSub.vendorEarningKobo).toBe(1350000); // N15,000 less 10% = N13,500, delivery not included
  });

  it("records the pickup and drop-off points and the distance as billed", async () => {
    const { customer, items } = await twoVendorScenario();
    const { subs } = await placeOrder(customer, items);
    const a = subs.find((s) => s.delivery!.distanceMeters === 3200)!;
    expect(a.delivery!.pickup!.line).toBeTruthy();
    expect(a.delivery!.dropoff).toMatchObject({ line: "12 Awolowo Avenue, Old Bodija, Ibadan", lat: 7.4, lng: 3.92 });
    expect(a.delivery).toMatchObject({ pricePerKmKobo: 20000, feeKobo: 64000, minFeeApplied: false });
  });

  it("writes a status log row for every sub-order and gives sequential order numbers", async () => {
    const { customer, items } = await twoVendorScenario();
    const first = await placeOrder(customer, items);
    const second = await placeOrder(customer, items);
    expect(second.data.orderNumber).toBe("VM-10002");
    const logs = await StatusLog.find({ orderId: first.order._id });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ from: null, to: "PENDING_PAYMENT", actorRole: "CUSTOMER", note: "Order placed" });
    expect(String(logs[0]!.actorId)).toBe(String(customer.user._id));
  });

  it("never hands out the same order number twice, even when orders are placed at the same moment", async () => {
    const vendor = await createVendor({ name: "Busy Store" });
    const product = await createProduct(vendor.vendor, { stock: 100 });
    const customers = await Promise.all(Array.from({ length: 6 }, (_, i) => createCustomer({ email: `buyer${i}@example.com` })));
    const results = await Promise.all(customers.map((c) => placeOrderReq(c.cookie, { items: [{ productId: String(product._id), qty: 2 }], addressId: String(c.address._id) })));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    const numbers = results.map((r) => r.body.data.orderNumber);
    expect(new Set(numbers).size).toBe(6);
    expect(new Set(results.map((r) => r.body.data.reference)).size).toBe(6);
    expect((await Product.findById(product._id))!.stock).toBe(88);
  });

  it("sets a 30 minute payment window", async () => {
    const { customer, items } = await twoVendorScenario();
    const { order } = await placeOrder(customer, items);
    const minutes = (order.expiresAt.getTime() - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThanOrEqual(30);
  });

  describe("price snapshot: later changes never alter a placed order", () => {
    it("ignores new admin rates, new product prices, a deleted product and an edited address", async () => {
      const { customer, items, flour, oil } = await twoVendorScenario();
      const { order, subs } = await placeOrder(customer, items);
      const before = JSON.stringify({ o: order.toObject(), s: subs.map((x) => x.toObject()) });

      await Settings.updateOne({ key: "singleton" }, { pricePerKmKobo: 99900, minDeliveryFeeKobo: 500000, commissionBps: 2500 });
      await Product.updateOne({ _id: flour._id }, { priceKobo: 9999999, name: "Renamed" });
      await oil.deleteOne();
      await Address.updateOne({ _id: customer.address._id }, { line: "Somewhere else entirely", "location.lat": 1, "location.lng": 1 });

      const afterOrder = (await Order.findById(order._id))!;
      const afterSubs = await SubOrder.find({ orderId: order._id }).sort({ ref: 1 });
      expect(JSON.stringify({ o: afterOrder.toObject(), s: afterSubs.map((x) => x.toObject()) })).toBe(before);
      expect(afterOrder.totalKobo).toBe(3222000);
      expect(afterSubs.flatMap((s) => s.items.map((i) => i.name)).sort()).toEqual(["Banga Palm Oil, 4L", "Omosalewa Bean Flour"]);
    });

    it("uses the rates in force at checkout for the next order", async () => {
      const { customer, items } = await twoVendorScenario();
      await placeOrder(customer, items);
      await Settings.updateOne({ key: "singleton" }, { pricePerKmKobo: 30000, commissionBps: 500 });
      const second = await placeOrder(customer, items);
      expect(second.order.pricing).toMatchObject({ pricePerKmKobo: 30000, commissionBps: 500 });
      expect(second.order.deliveryTotalKobo).toBe(96000 + 192000); // 3.2 km and 6.4 km at N300
    });
  });

  describe("stock", () => {
    it("holds the stock for the unpaid order", async () => {
      const { customer, items, flour, oil } = await twoVendorScenario();
      await placeOrder(customer, [{ productId: String(flour._id), qty: 3 }, { productId: items[1]!.productId, qty: 2 }]);
      expect((await Product.findById(flour._id))!.stock).toBe(7);
      expect((await Product.findById(oil._id))!.stock).toBe(8);
    });

    it("lets exactly one of two simultaneous buyers have the last unit, and never goes below zero", async () => {
      const vendor = await createVendor({ name: "Last One" });
      const product = await createProduct(vendor.vendor, { stock: 1 });
      const [a, b] = await Promise.all([createCustomer({ email: "a@example.com" }), createCustomer({ email: "b@example.com" })]);
      const body = (c: typeof a) => ({ items: [{ productId: String(product._id), qty: 1 }], addressId: String(c.address._id) });
      const [ra, rb] = await Promise.all([placeOrderReq(a.cookie, body(a)), placeOrderReq(b.cookie, body(b))]);
      expect([ra.status, rb.status].sort()).toEqual([201, 409]);
      expect((await Product.findById(product._id))!.stock).toBe(0);
      expect(await Order.countDocuments()).toBe(1);
    });

    it("rolls back every reservation if a later item cannot be reserved", async () => {
      const { customer, flour, oil } = await twoVendorScenario();
      // Looks fine when quoted, but the second product sells out in between.
      const original = Product.updateOne.bind(Product);
      let calls = 0;
      const spy = (Product as unknown as { updateOne: typeof Product.updateOne }).updateOne;
      (Product as unknown as { updateOne: unknown }).updateOne = (...args: Parameters<typeof Product.updateOne>) => {
        const filter = args[0] as { stock?: unknown };
        if (filter && typeof filter === "object" && "stock" in filter && ++calls === 2) return original({ _id: oil._id }, { stock: 0 }).then(() => original(...args));
        return original(...args);
      };
      try {
        const res = await placeOrderReq(customer.cookie, {
          items: [{ productId: String(flour._id), qty: 2 }, { productId: String(oil._id), qty: 1 }],
          addressId: String(customer.address._id),
        });
        expect(res.status).toBe(409);
      } finally {
        (Product as unknown as { updateOne: unknown }).updateOne = spy;
      }
      expect((await Product.findById(flour._id))!.stock).toBe(10); // the first reservation was returned
      expect(await Order.countDocuments()).toBe(0);
    });

    it("refuses a cart that exceeds stock, with nothing held and no order", async () => {
      const { customer, flour } = await twoVendorScenario();
      const res = await placeOrderReq(customer.cookie, { items: [{ productId: String(flour._id), qty: 11 }], addressId: String(customer.address._id) });
      expect(res.status).toBe(409);
      expect((await Product.findById(flour._id))!.stock).toBe(10);
      expect(await Order.countDocuments()).toBe(0);
      expect(fakeGateway.inits).toHaveLength(0);
    });
  });

  describe("when Paystack cannot be reached", () => {
    it("cancels the order, returns the stock and tells the shopper to retry", async () => {
      const { customer, items, flour } = await twoVendorScenario();
      fakeGateway.failInit = AppError.unavailable("We could not reach our payment provider. Please try again in a moment.");
      const res = await placeOrderReq(customer.cookie, { items, addressId: String(customer.address._id) });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");

      const order = (await Order.findOne())!;
      expect(order.status).toBe("CANCELLED");
      expect((await SubOrder.find()).map((s) => s.status)).toEqual(["CANCELLED", "CANCELLED"]);
      expect((await Product.findById(flour._id))!.stock).toBe(10);
      const last = await StatusLog.find({ to: "CANCELLED" });
      expect(last).toHaveLength(2);
      expect(last[0]).toMatchObject({ actorRole: "SYSTEM", note: "Payment could not be started" });
    });

    it("does the same for an unexpected crash, never leaving stock held", async () => {
      const { customer, items, flour } = await twoVendorScenario();
      fakeGateway.failInit = new Error("socket exploded");
      const res = await placeOrderReq(customer.cookie, { items, addressId: String(customer.address._id) });
      expect(res.status).toBe(500);
      expect((await Order.findOne())!.status).toBe("CANCELLED");
      expect((await Product.findById(flour._id))!.stock).toBe(10);
    });
  });

  describe("input and access", () => {
    it("rejects a client-supplied total, fee, price or reference", async () => {
      const { customer, items } = await twoVendorScenario();
      const addressId = String(customer.address._id);
      for (const extra of [{ totalKobo: 1 }, { deliveryFeeKobo: 1 }, { reference: "mine" }, { amountKobo: 100 }, { status: "PAID" }]) {
        expect((await placeOrderReq(customer.cookie, { items, addressId, ...extra })).status, JSON.stringify(extra)).toBe(422);
      }
      expect((await placeOrderReq(customer.cookie, { items: items.map((i) => ({ ...i, priceKobo: 1 })), addressId })).status).toBe(422);
      expect(await Order.countDocuments()).toBe(0);
    });

    it("refuses an empty cart, another customer's address, and a coming-soon city", async () => {
      const { customer, items } = await twoVendorScenario();
      expect((await placeOrderReq(customer.cookie, { items: [], addressId: String(customer.address._id) })).status).toBe(422);
      const other = await createCustomer({ email: "other@example.com" });
      expect((await placeOrderReq(customer.cookie, { items, addressId: String(other.address._id) })).status).toBe(404);
      expect(await Order.countDocuments()).toBe(0);
    });

    it("is for signed-in customers only", async () => {
      const { items, customer } = await twoVendorScenario();
      const body = { items, addressId: String(customer.address._id) };
      expect((await api().post("/api/checkout").set(XRW).send(body)).status).toBe(401);
      for (const role of ["VENDOR", "ADMIN", "HANDLER"] as const) {
        await createUser(role, `${role}@example.com`);
        expect((await placeOrderReq(await loginCookie(`${role}@example.com`), body)).status, role).toBe(403);
      }
      expect(await Order.countDocuments()).toBe(0);
    });
  });
});

describe("expiry of unpaid orders", () => {
  it("cancels an order past its window, returns the stock and logs it as the system", async () => {
    const { customer, items, flour, oil } = await twoVendorScenario();
    const { order } = await placeOrder(customer, items);
    expect((await Product.findById(flour._id))!.stock).toBe(9);
    await Order.updateOne({ _id: order._id }, { expiresAt: new Date(Date.now() - 1000) });

    expect(await expireStaleOrders()).toBe(1);
    expect((await Order.findById(order._id))!.status).toBe("CANCELLED");
    expect((await SubOrder.find({ orderId: order._id })).map((s) => s.status)).toEqual(["CANCELLED", "CANCELLED"]);
    expect((await Product.findById(flour._id))!.stock).toBe(10);
    expect((await Product.findById(oil._id))!.stock).toBe(10);
    const logs = await StatusLog.find({ orderId: order._id, to: "CANCELLED" });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ from: "PENDING_PAYMENT", actorRole: "SYSTEM", note: "Payment window expired" });
  });

  it("leaves orders that are still inside the window alone", async () => {
    const { customer, items, flour } = await twoVendorScenario();
    await placeOrder(customer, items);
    expect(await expireStaleOrders()).toBe(0);
    expect((await Product.findById(flour._id))!.stock).toBe(9);
  });

  it("never touches a paid order, even if its window has passed", async () => {
    const { customer, items, flour } = await twoVendorScenario();
    const { order } = await placeOrder(customer, items);
    await Order.updateOne({ _id: order._id }, { status: "PAID", expiresAt: new Date(Date.now() - 60000) });
    await SubOrder.updateMany({ orderId: order._id }, { status: "PAID" });
    expect(await expireStaleOrders()).toBe(0);
    expect((await Order.findById(order._id))!.status).toBe("PAID");
    expect((await Product.findById(flour._id))!.stock).toBe(9);
  });

  it("returns stock exactly once when the sweeper runs repeatedly or at the same time", async () => {
    const { customer, items, flour } = await twoVendorScenario();
    const { order } = await placeOrder(customer, items);
    await Order.updateOne({ _id: order._id }, { expiresAt: new Date(Date.now() - 1000) });
    const counts = await Promise.all([expireStaleOrders(), expireStaleOrders(), expireStaleOrders()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    await expireStaleOrders();
    expect((await Product.findById(flour._id))!.stock).toBe(10); // 10, not 11 or 12
    expect(await StatusLog.countDocuments({ orderId: order._id, to: "CANCELLED" })).toBe(2);
  });

  it("is applied on demand when the shopper looks at a stale order", async () => {
    const { customer, items, flour } = await twoVendorScenario();
    const { order, data } = await placeOrder(customer, items);
    await Order.updateOne({ _id: order._id }, { expiresAt: new Date(Date.now() - 1000) });
    const res = await api().get(`/api/orders/payment-status?reference=${data.reference}`).set("Cookie", customer.cookie);
    expect(res.body.data.status).toBe("CANCELLED");
    expect((await Product.findById(flour._id))!.stock).toBe(10);
  });
});

describe("customer order views", () => {
  it("lists only the customer's own orders, newest first, with paging totals", async () => {
    const { customer, items } = await twoVendorScenario();
    const other = await createCustomer({ email: "other@example.com" });
    const a = await placeOrder(customer, items);
    const b = await placeOrder(customer, items);
    await placeOrder(other, items);
    const res = await api().get("/api/orders").set("Cookie", customer.cookie);
    expect(res.body.meta.total).toBe(2);
    expect(res.body.data.map((o: { orderNumber: string }) => o.orderNumber)).toEqual([b.data.orderNumber, a.data.orderNumber]);
    expect(res.body.data[0]).toMatchObject({ status: "PENDING_PAYMENT", totalKobo: 3222000, itemCount: 2, moreItems: false, deliveries: ["PENDING_PAYMENT", "PENDING_PAYMENT"] });
    expect(res.body.data[0].itemNames.sort()).toEqual(["Banga Palm Oil, 4L", "Omosalewa Bean Flour"]);
  });

  it("shows an order with each vendor's part, items, delivery leg and timeline", async () => {
    const { customer, items } = await twoVendorScenario();
    const { data } = await placeOrder(customer, items);
    const res = await api().get(`/api/orders/${data.orderId}`).set("Cookie", customer.cookie);
    expect(res.status).toBe(200);
    const o = res.body.data;
    expect(o).toMatchObject({ orderNumber: "VM-10001", totalKobo: 3222000, itemsSubtotalKobo: 3030000, deliveryTotalKobo: 192000, address: { line: "12 Awolowo Avenue, Old Bodija, Ibadan" } });
    expect(o.subOrders).toHaveLength(2);
    const sub = o.subOrders.find((s: { vendor: { businessName: string } }) => s.vendor.businessName === "Bodija Provisions");
    expect(sub).toMatchObject({ ref: "VM-10001-A", status: "PENDING_PAYMENT", itemsTotalKobo: 1500000, delivery: { distanceKm: "3.2", feeKobo: 64000, pricePerKmKobo: 20000 } });
    expect(sub.items[0]).toMatchObject({ name: "Omosalewa Bean Flour", qty: 1, unitPriceKobo: 1500000, lineTotalKobo: 1500000 });
    expect(sub.timeline).toEqual([expect.objectContaining({ status: "PENDING_PAYMENT", note: "Order placed" })]);
  });

  it("never exposes commission or vendor earnings to the customer", async () => {
    const { customer, items } = await twoVendorScenario();
    const { data } = await placeOrder(customer, items);
    const text = JSON.stringify([(await api().get(`/api/orders/${data.orderId}`).set("Cookie", customer.cookie)).body, (await api().get("/api/orders").set("Cookie", customer.cookie)).body]);
    // (The word "payment" is not checked: PENDING_PAYMENT is a normal status the customer sees.)
    for (const word of ["commission", "vendorEarning", "paystack", "passwordHash", "accountNumber", "bank"]) expect(text.toLowerCase(), word).not.toContain(word.toLowerCase());
  });

  it("keeps orders private: another customer, a guest or staff get 404, 401 or 403", async () => {
    const { customer, items } = await twoVendorScenario();
    const { data } = await placeOrder(customer, items);
    const other = await createCustomer({ email: "snoop@example.com" });
    expect((await api().get(`/api/orders/${data.orderId}`).set("Cookie", other.cookie)).status).toBe(404);
    expect((await api().get(`/api/orders/payment-status?reference=${data.reference}`).set("Cookie", other.cookie)).status).toBe(404);
    expect((await api().get(`/api/orders/${data.orderId}`)).status).toBe(401);
    await createUser("ADMIN", "admin@example.com");
    expect((await api().get(`/api/orders/${data.orderId}`).set("Cookie", await loginCookie("admin@example.com"))).status).toBe(403);
    expect((await api().get("/api/orders/nope").set("Cookie", customer.cookie)).status).toBe(422);
  });

  it("answers the payment-status poll with the order status", async () => {
    const { customer, items } = await twoVendorScenario();
    const { data } = await placeOrder(customer, items);
    const res = await api().get(`/api/orders/payment-status?reference=${data.reference}`).set("Cookie", customer.cookie);
    expect(res.body.data).toMatchObject({ orderId: data.orderId, orderNumber: "VM-10001", status: "PENDING_PAYMENT", totalKobo: 3222000, needsAttention: false });
  });
});

describe("subOrderLetter", () => {
  it("counts A to Z then AA, AB", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(subOrderLetter)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });
});
