import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SubOrder } from "../src/models/SubOrder.js";
import { clearDb, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin, createHandler, paidOrder } from "./fulfilmentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

type Row = { id: string; deliveredAt: string | null };

/** Takes Bodija's delivery all the way: packed by the vendor, given to a handler, picked up, delivered. Returns what each step saw. */
async function deliverBodija() {
  const o = await paidOrder();
  const admin = await createAdmin();
  const rider = await createHandler();
  const a = asUser(admin.bearer);
  const h = asUser(rider.bearer);
  expect((await asUser(o.vendorTokens.bodija).post(`/vendor/orders/${o.bodijaSub._id}/ready`)).status).toBe(200);
  expect((await a.post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, { handlerId: String(rider.user._id) })).status).toBe(200);
  expect((await h.post(`/handler/deliveries/${o.bodijaSub._id}/status`, { to: "PICKED_UP" })).status).toBe(200);

  const before = Date.now();
  const res = await h.post(`/handler/deliveries/${o.bodijaSub._id}/status`, { to: "DELIVERED" });
  const after = Date.now();
  expect(res.status).toBe(200);
  return { ...o, a, h, rider, before, after };
}

describe("when a delivery was delivered", () => {
  it("is captured the moment the handler marks it delivered, and not before", async () => {
    const o = await paidOrder();
    expect((await SubOrder.findById(o.bodijaSub._id))!.deliveredAt).toBeUndefined();

    const d = await deliverBodija();
    const sub = (await SubOrder.findById(d.bodijaSub._id))!;
    expect(sub.status).toBe("DELIVERED");
    expect(sub.deliveredAt!.getTime()).toBeGreaterThanOrEqual(d.before - 1000);
    expect(sub.deliveredAt!.getTime()).toBeLessThanOrEqual(d.after + 1000);
  });

  it("shows on the admin's deliveries list, with the delivered ones newest first", async () => {
    const d = await deliverBodija();
    // Make the other store's delivery arrive earlier, so the order of the list is something we can check.
    await SubOrder.updateOne({ _id: d.ojabaSub._id }, { status: "DELIVERED", deliveredAt: new Date(Date.now() - 3 * 3_600_000) });

    const done = await d.a.get("/admin/deliveries?group=done");
    const rows = done.body.data.deliveries as Row[];
    expect(rows.map((r) => r.id)).toEqual([String(d.bodijaSub._id), String(d.ojabaSub._id)]); // Bodija just now, Oja'ba 3 hours ago
    expect(new Date(rows[0]!.deliveredAt!).getTime()).toBeGreaterThanOrEqual(d.before - 1000);
    expect(new Date(rows[1]!.deliveredAt!).getTime()).toBeLessThan(new Date(rows[0]!.deliveredAt!).getTime());

    // Newest first even when the older one was paid later.
    await SubOrder.updateOne({ _id: d.ojabaSub._id }, { paidAt: new Date() });
    await SubOrder.updateOne({ _id: d.bodijaSub._id }, { paidAt: new Date(Date.now() - 86_400_000) });
    const again = (await d.a.get("/admin/deliveries?group=done")).body.data.deliveries as Row[];
    expect(again.map((r) => r.id)).toEqual([String(d.bodijaSub._id), String(d.ojabaSub._id)]);
  });

  it("is empty for a delivery that has not arrived", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    const rows = (await asUser(admin.bearer).get("/admin/deliveries?group=all")).body.data.deliveries as Row[];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.deliveredAt).toBeNull();
    expect(o.bodijaSub.status).toBe("PAID");
  });

  it("shows on the handler's own list once finished, not before", async () => {
    const d = await deliverBodija();
    const finished = (await d.h.get("/handler/deliveries?group=done")).body.data.deliveries as Row[];
    expect(finished).toHaveLength(1);
    expect(new Date(finished[0]!.deliveredAt!).getTime()).toBeGreaterThanOrEqual(d.before - 1000);

    const o2 = await paidOrder();
    const admin = await createAdmin("second-admin@example.com");
    await asUser(admin.bearer).post(`/admin/sub-orders/${o2.bodijaSub._id}/assign`, { handlerId: String(d.rider.user._id) });
    const todo = (await d.h.get("/handler/deliveries?group=active")).body.data.deliveries as Row[];
    expect(todo.length).toBeGreaterThan(0);
    for (const r of todo) expect(r.deliveredAt).toBeNull();
  });

  it("shows on the customer's order, for the delivered parcel only", async () => {
    const d = await deliverBodija();
    const order = await asUser(d.customer.bearer).get(`/orders/${d.data.orderId}`);
    const subs = order.body.data.subOrders as { id: string; deliveredAt: string | null }[];
    const delivered = subs.find((s) => s.id === String(d.bodijaSub._id))!;
    const waiting = subs.find((s) => s.id === String(d.ojabaSub._id))!;
    expect(new Date(delivered.deliveredAt!).getTime()).toBeGreaterThanOrEqual(d.before - 1000);
    expect(waiting.deliveredAt).toBeNull();
  });
});
