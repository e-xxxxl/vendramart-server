import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { City } from "../src/models/City.js";
import { Order } from "../src/models/Order.js";
import { SubOrder } from "../src/models/SubOrder.js";
import { getPricing } from "../src/models/Settings.js";
import { api, clearDb, createUser, fakeDistance, loginToken, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin, createHandler, emailLog, paidOrder } from "./fulfilmentHelpers.js";
import { fakeGateway } from "./paymentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  fakeDistance.reset();
  fakeGateway.reset();
  emailLog.reset();
});

const PRICING = { pricePerKmKobo: 20000, minDeliveryFeeKobo: null, commissionBps: 1000 };

describe("who may use the admin dashboard routes", () => {
  it("is for admins only", async () => {
    const o = await paidOrder();
    const handler = await createHandler();
    const gets = ["/admin/overview", "/admin/orders", `/admin/orders/${o.order._id}`, "/admin/customers", "/admin/settings", "/admin/search?q=bo"];
    for (const bearer of [o.customer.bearer, o.vendorTokens.bodija, handler.bearer]) {
      for (const path of gets) expect((await asUser(bearer).get(path)).status, path).toBe(403);
      expect((await asUser(bearer).post(`/admin/orders/${o.order._id}/resolve`, { note: "done" })).status).toBe(403);
      expect((await asUser(bearer).patch("/admin/settings", PRICING)).status).toBeGreaterThanOrEqual(403);
      expect((await api().put("/api/admin/settings").set("Authorization", bearer).send(PRICING)).status).toBe(403);
      expect((await api().post("/api/admin/settings/preview").set("Authorization", bearer).send({ ...PRICING, distanceMeters: 1000, saleKobo: 1000 })).status).toBe(403);
    }
    for (const path of gets) expect((await api().get(`/api${path}`)).status, path).toBe(401);
  });
});

describe("overview", () => {
  it("is all zeros before anything has been sold", async () => {
    const admin = await createAdmin();
    const res = await asUser(admin.bearer).get("/admin/overview");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      sales: { orders: 0, grossKobo: 0 },
      commissionKobo: 0,
      vendors: { approved: 0, pending: 0, suspended: 0 },
      payouts: { pendingCount: 0, pendingKobo: 0 },
      needsAttention: 0,
    });
    expect(res.body.data.last7Days).toHaveLength(7);
    expect(res.body.data.last7Days.every((d: { orders: number }) => d.orders === 0)).toBe(true);
  });

  it("adds up paid orders, commission, vendors and the delivery queue", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    const res = await asUser(admin.bearer).get("/admin/overview");
    const order = (await Order.findById(o.order._id))!;
    const subs = await SubOrder.find({ orderId: order._id });

    expect(res.body.data.sales).toEqual({ orders: 1, grossKobo: order.totalKobo, itemsKobo: order.itemsSubtotalKobo, deliveryKobo: order.deliveryTotalKobo });
    expect(res.body.data.commissionKobo).toBe(subs.reduce((n, s) => n + s.commissionTotalKobo, 0));
    expect(res.body.data.vendors.approved).toBe(2);
    expect(res.body.data.customers).toBe(1);
    expect(res.body.data.deliveries).toEqual({ needsHandler: 2, inProgress: 2, failed: 0 });

    const today = res.body.data.last7Days.at(-1);
    expect(today).toMatchObject({ orders: 1, grossKobo: order.totalKobo });
  });

  it("counts an order paid early on the first day of the week in that day's bar", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    const firstDay = day(new Date(Date.now() - 6 * 86_400_000));
    const earlyOnFirstDay = new Date(new Date(`${firstDay}T00:00:00+01:00`).getTime() + 5 * 60_000);
    await Order.updateOne({ _id: o.order._id }, { "payment.paidAt": earlyOnFirstDay });

    const res = await asUser(admin.bearer).get("/admin/overview");
    expect(res.body.data.last7Days[0]).toMatchObject({ date: firstDay, orders: 1 });
    expect(res.body.data.last7Days.reduce((n: number, d: { orders: number }) => n + d.orders, 0)).toBe(1);
  });

  it("does not count a cancelled sub-order towards commission", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    await SubOrder.updateOne({ _id: o.ojabaSub._id }, { status: "CANCELLED" });
    const res = await asUser(admin.bearer).get("/admin/overview");
    expect(res.body.data.commissionKobo).toBe(o.bodijaSub.commissionTotalKobo);
  });
});

describe("orders", () => {
  it("lists orders with a count for each group, and finds one by its number or customer", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    const a = asUser(admin.bearer);

    const all = await a.get("/admin/orders");
    expect(all.body.data.counts).toMatchObject({ all: 1, paid: 1, attention: 0, cancelled: 0 });
    expect(all.body.data.orders[0]).toMatchObject({ orderNumber: o.order.orderNumber, status: "PAID", totalKobo: o.order.totalKobo });

    expect((await a.get(`/admin/orders?q=${o.order.orderNumber}`)).body.data.orders).toHaveLength(1);
    expect((await a.get("/admin/orders?q=no-such-order")).body.data.orders).toHaveLength(0);
    expect((await a.get("/admin/orders?group=cancelled")).body.data.orders).toHaveLength(0);
    expect((await a.get("/admin/orders?group=bogus")).status).toBe(422);
  });

  it("shows the full order with each vendor's part, the pricing it was placed under, and its history", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    const res = await asUser(admin.bearer).get(`/admin/orders/${o.order._id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.subOrders).toHaveLength(2);
    expect(res.body.data.subOrders.map((s: { vendorName: string }) => s.vendorName).sort()).toEqual(["Bodija Provisions", "Oja'ba Foodstuff"]);
    expect(res.body.data.pricing).toMatchObject({ pricePerKmKobo: 20000, commissionBps: 1000 });
    expect(res.body.data.history.length).toBeGreaterThanOrEqual(2);
    expect((await asUser(admin.bearer).get("/admin/orders/aaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
    expect((await asUser(admin.bearer).get("/admin/orders/not-an-id")).status).toBe(422);
  });

  it("lists orders that need attention, and lets an admin record that they were dealt with, once", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    const a = asUser(admin.bearer);
    await Order.updateOne({ _id: o.order._id }, { needsAttention: true, attentionReason: "Payment arrived after the order expired" });

    const flagged = await a.get("/admin/orders?group=attention");
    expect(flagged.body.data.counts.attention).toBe(1);
    expect(flagged.body.data.orders[0]).toMatchObject({ needsAttention: true, attentionReason: "Payment arrived after the order expired" });
    expect((await a.get("/admin/overview")).body.data.needsAttention).toBe(1);

    expect((await a.post(`/admin/orders/${o.order._id}/resolve`, {})).status).toBe(422);
    expect((await a.post(`/admin/orders/${o.order._id}/resolve`, { note: "no" })).status).toBe(422);

    const done = await a.post(`/admin/orders/${o.order._id}/resolve`, { note: "Refunded in the Paystack dashboard" });
    expect(done.status).toBe(200);
    expect(done.body.data.needsAttention).toBe(false);

    const stored = (await Order.findById(o.order._id))!;
    expect(stored.attentionResolvedBy).toEqual(admin.user._id);
    expect(stored.attentionNote).toBe("Refunded in the Paystack dashboard");
    expect((await a.get("/admin/orders?group=attention")).body.data.orders).toHaveLength(0);

    expect((await a.post(`/admin/orders/${o.order._id}/resolve`, { note: "Refunded again" })).status).toBe(409);
    expect((await a.post("/admin/orders/aaaaaaaaaaaaaaaaaaaaaaaa/resolve", { note: "Whatever happened" })).status).toBe(404);
  });
});

describe("customers", () => {
  it("lists customers only, with how many orders and how much they have paid for", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    await createUser("HANDLER", "someone@example.com");
    const res = await asUser(admin.bearer).get("/admin/customers");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ email: o.customer.email, orders: 1, spentKobo: o.order.totalKobo, isActive: true });
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
    expect((await asUser(admin.bearer).get("/admin/customers?q=zzzz")).body.data).toHaveLength(0);
    expect((await asUser(admin.bearer).get(`/admin/customers?q=${o.customer.email.slice(0, 4)}`)).body.data).toHaveLength(1);
  });

  it("does not count an unpaid order as spending", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    await Order.updateOne({ _id: o.order._id }, { status: "CANCELLED" });
    const res = await asUser(admin.bearer).get("/admin/customers");
    expect(res.body.data[0]).toMatchObject({ orders: 0, spentKobo: 0 });
  });
});

describe("pricing settings", () => {
  it("shows the current pricing and every city with its live store count", async () => {
    await paidOrder();
    const admin = await createAdmin();
    const res = await asUser(admin.bearer).get("/admin/settings");
    expect(res.body.data.pricing).toEqual(PRICING);
    const ibadan = res.body.data.cities.find((c: { slug: string }) => c.slug === "ibadan");
    expect(ibadan).toMatchObject({ isActive: true, vendorCount: 2 });
    expect(res.body.data.cities.find((c: { slug: string }) => c.slug === "lagos")).toMatchObject({ isActive: false, vendorCount: 0 });
  });

  it("saves new pricing, and past orders keep the pricing they were placed under", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    const body = { pricePerKmKobo: 30000, minDeliveryFeeKobo: 50000, commissionBps: 1500 };
    const res = await api().put("/api/admin/settings").set("Authorization", admin.bearer).send(body);
    expect(res.status).toBe(200);
    expect(res.body.data.pricing).toEqual(body);
    expect(await getPricing()).toEqual(body);

    const old = (await Order.findById(o.order._id))!;
    expect(old.pricing).toMatchObject({ pricePerKmKobo: 20000, commissionBps: 1000 });
    expect((await SubOrder.findById(o.bodijaSub._id))!.commissionBps).toBe(1000);
  });

  it("can clear the minimum delivery fee back to none", async () => {
    const admin = await createAdmin();
    const put = (body: unknown) => api().put("/api/admin/settings").set("Authorization", admin.bearer).send(body as object);
    await put({ ...PRICING, minDeliveryFeeKobo: 50000 });
    expect((await getPricing()).minDeliveryFeeKobo).toBe(50000);
    expect((await put(PRICING)).status).toBe(200);
    expect((await getPricing()).minDeliveryFeeKobo).toBeNull();
  });

  it("rejects values that are not whole kobo, are negative, absurdly large, or unknown", async () => {
    const admin = await createAdmin();
    const put = (body: unknown) => api().put("/api/admin/settings").set("Authorization", admin.bearer).send(body as object);
    for (const bad of [
      { ...PRICING, pricePerKmKobo: 200.5 },
      { ...PRICING, pricePerKmKobo: -1 },
      { ...PRICING, pricePerKmKobo: 99_999_999 },
      { ...PRICING, minDeliveryFeeKobo: 1.5 },
      { ...PRICING, minDeliveryFeeKobo: -5 },
      { ...PRICING, commissionBps: 10001 },
      { ...PRICING, commissionBps: -1 },
      { ...PRICING, commissionBps: 10.5 },
      { ...PRICING, pricePerKmKobo: "200" },
      { ...PRICING, extra: true },
      { pricePerKmKobo: 20000 },
    ]) {
      expect((await put(bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect(await getPricing()).toEqual(PRICING);
  });

  it("previews a delivery fee and what a vendor earns, using the same maths as orders and saving nothing", async () => {
    const admin = await createAdmin();
    const preview = (body: unknown) => api().post("/api/admin/settings/preview").set("Authorization", admin.bearer).send(body as object);

    // The admin screen: 6.4 km at N200 per km is N1,280, and a N15,000 sale leaves the vendor N13,500.
    const res = await preview({ ...PRICING, distanceMeters: 6400, saleKobo: 1_500_000 });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ distanceTenthsKm: 64, deliveryFeeKobo: 128000, minFeeApplied: false, saleKobo: 1_500_000, commissionKobo: 150000, vendorEarningKobo: 1_350_000 });

    const floor = await preview({ ...PRICING, minDeliveryFeeKobo: 100000, distanceMeters: 1000, saleKobo: 1_500_000 });
    expect(floor.body.data).toMatchObject({ deliveryFeeKobo: 100000, minFeeApplied: true });

    expect((await preview({ ...PRICING, distanceMeters: -1, saleKobo: 1000 })).status).toBe(422);
    expect((await preview({ ...PRICING, distanceMeters: 1000, saleKobo: 10.5 })).status).toBe(422);
    expect(await getPricing()).toEqual(PRICING);
  });
});

describe("city switches", () => {
  it("turns a city on and off, and the storefront follows", async () => {
    const admin = await createAdmin();
    const lagos = (await City.findOne({ slug: "lagos" }))!;
    const patch = (id: string, body: unknown) => api().patch(`/api/admin/cities/${id}`).set("Authorization", admin.bearer).send(body as object);

    const on = await patch(String(lagos._id), { isActive: true });
    expect(on.status).toBe(200);
    expect(on.body.data).toMatchObject({ slug: "lagos", isActive: true });
    const cities = await api().get("/api/cities");
    expect(cities.body.data.find((c: { slug: string }) => c.slug === "lagos").isActive).toBe(true);

    expect((await patch(String(lagos._id), { isActive: false })).body.data.isActive).toBe(false);
    expect((await patch(String(lagos._id), { isActive: "yes" })).status).toBe(422);
    expect((await patch(String(lagos._id), { isActive: true, name: "Renamed" })).status).toBe(422);
    expect((await patch("aaaaaaaaaaaaaaaaaaaaaaaa", { isActive: true })).status).toBe(404);
  });

  it("is for admins only", async () => {
    const o = await paidOrder();
    const lagos = (await City.findOne({ slug: "lagos" }))!;
    const res = await api().patch(`/api/admin/cities/${lagos._id}`).set("Authorization", o.vendorTokens.bodija).send({ isActive: true });
    expect(res.status).toBe(403);
    expect((await City.findById(lagos._id))!.isActive).toBe(false);
  });
});

describe("search", () => {
  it("finds orders, stores and customers in one go, and says where each opens", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    const a = asUser(admin.bearer);

    const byStore = await a.get("/admin/search?q=bodija");
    expect(byStore.body.data.vendors.map((v: { title: string }) => v.title)).toEqual(["Bodija Provisions"]);
    expect(byStore.body.data.vendors[0].href).toMatch(/^\/admin\/vendors\?id=[a-f0-9]{24}$/);

    const byOrder = await a.get(`/admin/search?q=${o.order.orderNumber}`);
    expect(byOrder.body.data.orders).toHaveLength(1);
    expect(byOrder.body.data.orders[0].href).toBe(`/admin/orders?id=${o.order._id}`);

    const byCustomer = await a.get(`/admin/search?q=${encodeURIComponent(o.customer.email.slice(0, 5))}`);
    expect(byCustomer.body.data.customers).toHaveLength(1);
  });

  it("finds a payout request by its number", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "DELIVERED", deliveredAt: new Date(Date.now() - 10 * 24 * 3600_000) }); // well past the 4 working day hold
    const made = await asUser(o.vendorTokens.bodija).post("/vendor/payouts");
    expect(made.status).toBe(201);
    const res = await asUser(admin.bearer).get(`/admin/search?q=${made.body.data.number}`);
    expect(res.body.data.payouts).toHaveLength(1);
    expect(res.body.data.payouts[0].href).toContain("/admin/payouts?tab=pending&id=");
  });

  it("needs at least two characters, treats special characters as plain text, and never returns private details", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    const a = asUser(admin.bearer);
    expect((await a.get("/admin/search?q=b")).status).toBe(422);
    expect((await a.get("/admin/search")).status).toBe(422);
    const odd = await a.get(`/admin/search?q=${encodeURIComponent(".*(")}`);
    expect(odd.status).toBe(200);
    expect(odd.body.data).toEqual({ orders: [], vendors: [], customers: [], payouts: [] });

    const all = JSON.stringify((await a.get("/admin/search?q=bo")).body);
    for (const secret of ["0123456789", "accountNumber", "passwordHash", o.customer.bearer]) expect(all, secret).not.toContain(secret);
    expect(await loginToken(admin.email)).toBeTruthy();
  });
});
