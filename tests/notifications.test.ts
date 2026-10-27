import type { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Notification } from "../src/models/Notification.js";
import { User } from "../src/models/User.js";
import { EmailChannel } from "../src/services/notifications/channels.js";
import { NotificationService, type NotificationChannel } from "../src/services/notifications/NotificationService.js";
import { api, clearDb, createUser, fakeDistance, loginCookie, seedReferenceData, startDb, stopDb, XRW } from "./helpers.js";
import { asUser, createAdmin, createHandler, emailLog, paidOrder } from "./fulfilmentHelpers.js";
import { chargeSuccess, fakeGateway, sendWebhook } from "./paymentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  fakeDistance.reset();
  fakeGateway.reset();
  emailLog.reset();
});

/** Titles of the notifications stored for one user, oldest first. */
const titlesFor = async (userId: Types.ObjectId) => (await Notification.find({ userId }).sort({ createdAt: 1 })).map((n) => n.title);
const kindsFor = async (userId: Types.ObjectId) => (await Notification.find({ userId }).sort({ createdAt: 1 })).map((n) => n.kind);

describe("when an order is paid", () => {
  it("tells the customer once, each vendor about their own part, and the admin", async () => {
    await createAdmin();
    const admin = (await User.findOne({ role: "ADMIN" }))!;
    emailLog.reset();
    const o = await paidOrder();

    expect(await kindsFor(o.customer.user._id)).toEqual(["ORDER_PAID"]); // one payment, one message, even with two vendors
    expect(await titlesFor(o.customer.user._id)).toEqual(["Payment received"]);
    expect(await kindsFor(o.bodija.user._id)).toEqual(["NEW_ORDER"]);
    expect(await kindsFor(o.ojaba.user._id)).toEqual(["NEW_ORDER"]);
    expect(await titlesFor(o.bodija.user._id)).toEqual([`New order ${o.bodijaSub.ref}`]);
    expect(await kindsFor(admin._id)).toEqual(["ORDER_NEEDS_HANDLER"]);
    void admin;
  });

  it("sends the same messages by email", async () => {
    const o = await paidOrder();
    expect(emailLog.to(o.customer.email).map((m) => m.title)).toEqual(["Payment received"]);
    expect(emailLog.to(o.bodija.email).map((m) => m.title)).toEqual([`New order ${o.bodijaSub.ref}`]);
  });

  it("does not notify again when Paystack replays the webhook", async () => {
    const o = await paidOrder();
    const before = await Notification.countDocuments();
    await sendWebhook(chargeSuccess(o.data.reference));
    await sendWebhook(chargeSuccess(o.data.reference));
    expect(await Notification.countDocuments()).toBe(before);
  });

  it("does not tell a vendor about the other vendor's order", async () => {
    const o = await paidOrder();
    const bodijaNotes = await Notification.find({ userId: o.bodija.user._id });
    expect(JSON.stringify(bodijaNotes)).not.toContain(o.ojabaSub.ref);
  });
});

describe("as the delivery moves along", () => {
  async function flow() {
    const o = await paidOrder();
    const admin = await createAdmin();
    const rider = await createHandler();
    await Notification.deleteMany({});
    emailLog.reset();
    return { ...o, admin, rider, a: asUser(admin.cookie), h: asUser(rider.cookie), v: asUser(o.vendorCookies.bodija), subId: String(o.bodijaSub._id) };
  }

  it("assigning tells the handler and the vendor, not the customer", async () => {
    const o = await flow();
    await o.a.post(`/admin/sub-orders/${o.subId}/assign`, { handlerId: String(o.rider.user._id) });
    expect(await kindsFor(o.rider.user._id)).toEqual(["DELIVERY_ASSIGNED"]);
    expect(await kindsFor(o.bodija.user._id)).toEqual(["HANDLER_ASSIGNED"]);
    expect(await kindsFor(o.customer.user._id)).toEqual([]);
    expect(await kindsFor(o.admin.user._id)).toEqual([]); // not told about their own click
    const note = (await Notification.findOne({ userId: o.rider.user._id }))!;
    expect(note.link).toBe(`/handler/delivery/?id=${o.subId}`);
    // The handler is told where to collect and where to deliver (the fixture's pickup is "Somewhere, Ibadan").
    expect(note.body).toContain("Somewhere, Ibadan");
    expect(note.body).toContain("12 Awolowo Avenue");
  });

  it("marking ready tells the customer and the assigned handler, but not the vendor who clicked", async () => {
    const o = await flow();
    await o.a.post(`/admin/sub-orders/${o.subId}/assign`, { handlerId: String(o.rider.user._id) });
    await Notification.deleteMany({});
    await o.v.post(`/vendor/orders/${o.subId}/ready`);
    expect(await kindsFor(o.customer.user._id)).toEqual(["READY_FOR_PICKUP"]);
    expect(await kindsFor(o.rider.user._id)).toEqual(["READY_FOR_PICKUP"]);
    expect(await kindsFor(o.bodija.user._id)).toEqual([]);
    expect(await kindsFor(o.admin.user._id)).toEqual([]); // a handler is assigned, so no alarm for the admin
  });

  it("warns the admin when something is ready but nobody has been assigned", async () => {
    const o = await flow();
    await o.v.post(`/vendor/orders/${o.subId}/ready`);
    expect(await kindsFor(o.admin.user._id)).toEqual(["READY_UNASSIGNED"]);
    expect(await kindsFor(o.customer.user._id)).toEqual(["READY_FOR_PICKUP"]);
  });

  it("pickup and delivery tell both the customer and the vendor, and delivery mentions the 24-hour hold", async () => {
    const o = await flow();
    await o.a.post(`/admin/sub-orders/${o.subId}/assign`, { handlerId: String(o.rider.user._id) });
    await o.v.post(`/vendor/orders/${o.subId}/ready`);
    await Notification.deleteMany({});

    await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "PICKED_UP" });
    expect(await kindsFor(o.customer.user._id)).toEqual(["PICKED_UP"]);
    expect(await kindsFor(o.bodija.user._id)).toEqual(["PICKED_UP"]);
    expect(await kindsFor(o.rider.user._id)).toEqual([]); // the handler made the change

    await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "DELIVERED" });
    expect(await kindsFor(o.customer.user._id)).toEqual(["PICKED_UP", "DELIVERED"]);
    const vendorNote = (await Notification.findOne({ userId: o.bodija.user._id, kind: "DELIVERED" }))!;
    expect(vendorNote.body).toMatch(/24 hours after delivery/);
    expect(vendorNote.link).toBe("/vendor/earnings");
    // Both of them also got the email.
    expect(emailLog.to(o.customer.email).map((m) => m.title)).toContain("Delivered");
    expect(emailLog.to(o.bodija.email).map((m) => m.title)).toContain(`${o.bodijaSub.ref} delivered`);
  });

  it("a failed delivery tells the customer, the vendor and the admin, with the reason", async () => {
    const o = await flow();
    await o.a.post(`/admin/sub-orders/${o.subId}/assign`, { handlerId: String(o.rider.user._id) });
    await o.v.post(`/vendor/orders/${o.subId}/ready`);
    await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "PICKED_UP" });
    await Notification.deleteMany({});
    await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "FAILED_DELIVERY", reason: "Gate was locked and phone off" });
    for (const id of [o.customer.user._id, o.bodija.user._id, o.admin.user._id]) {
      const n = (await Notification.findOne({ userId: id }))!;
      expect(n.kind).toBe("FAILED_DELIVERY");
      expect(n.body).toContain("Gate was locked and phone off");
    }
  });

  it("an admin cancellation tells the customer and the vendor", async () => {
    const o = await flow();
    await o.a.post(`/admin/sub-orders/${o.subId}/status`, { to: "CANCELLED" });
    expect(await kindsFor(o.customer.user._id)).toEqual(["CANCELLED"]);
    expect(await kindsFor(o.bodija.user._id)).toEqual(["CANCELLED"]);
    expect(await kindsFor(o.ojaba.user._id)).toEqual([]); // the other vendor's part is unaffected
  });

  it("does not notify anyone when a move is refused", async () => {
    const o = await flow();
    await o.a.post(`/admin/sub-orders/${o.subId}/assign`, { handlerId: String(o.rider.user._id) });
    await Notification.deleteMany({});
    const res = await o.h.post(`/handler/deliveries/${o.subId}/status`, { to: "PICKED_UP" }); // not ready yet
    expect(res.status).toBe(409);
    expect(await Notification.countDocuments()).toBe(0);
  });
});

describe("privacy of the messages", () => {
  it("never puts the customer's phone, email or address in what the vendor is told, or the vendor's phone in what the customer is told", async () => {
    const o = await paidOrder();
    const admin = await createAdmin();
    const rider = await createHandler();
    await asUser(admin.cookie).post(`/admin/sub-orders/${o.bodijaSub._id}/assign`, { handlerId: String(rider.user._id) });
    await asUser(o.vendorCookies.bodija).post(`/vendor/orders/${o.bodijaSub._id}/ready`);
    await asUser(rider.cookie).post(`/handler/deliveries/${o.bodijaSub._id}/status`, { to: "PICKED_UP" });
    await asUser(rider.cookie).post(`/handler/deliveries/${o.bodijaSub._id}/status`, { to: "DELIVERED" });

    const vendorText = JSON.stringify(await Notification.find({ userId: o.bodija.user._id })) + JSON.stringify(emailLog.to(o.bodija.email));
    for (const secret of [o.customer.email, "08030000000", "Awolowo", "Old Bodija"]) expect(vendorText, secret).not.toContain(secret);

    const customerText = JSON.stringify(await Notification.find({ userId: o.customer.user._id })) + JSON.stringify(emailLog.to(o.customer.email));
    for (const secret of [o.bodija.email, "08031234567"]) expect(customerText, secret).not.toContain(secret);
  });
});

describe("a failing channel never blocks the order", () => {
  it("still completes the action and still stores the in-app message when email fails", async () => {
    const o = await paidOrder();
    vi.spyOn(console, "error").mockImplementation(() => {});
    emailLog.reset(); // forget the emails from setting up the paid order
    emailLog.failWith = new Error("SMTP connection refused");
    await Notification.deleteMany({});

    const res = await asUser(o.vendorCookies.bodija).post(`/vendor/orders/${o.bodijaSub._id}/ready`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("READY_FOR_PICKUP");
    expect(await kindsFor(o.customer.user._id)).toEqual(["READY_FOR_PICKUP"]); // in-app still worked
    expect(emailLog.sent).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it("isolates one failing channel from the others, per recipient", async () => {
    const sent: string[] = [];
    const bad: NotificationChannel = { name: "bad", send: async () => { throw new Error("boom"); } };
    const good: NotificationChannel = { name: "good", send: async (to) => { sent.push(to.id); } };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await new NotificationService([bad, good]).notify(
      [{ id: "1", name: "A", email: "a@x.com" }, { id: "2", name: "B", email: "b@x.com" }],
      { kind: "T", title: "t", body: "b" },
    );
    expect(sent).toEqual(["1", "2"]);
    vi.restoreAllMocks();
  });

  it("sends each person a message once even if they are listed twice", async () => {
    const sent: string[] = [];
    const ch: NotificationChannel = { name: "c", send: async (to) => { sent.push(to.id); } };
    await new NotificationService([ch]).notify([{ id: "1", name: "A", email: "a@x.com" }, { id: "1", name: "A", email: "a@x.com" }], { kind: "T", title: "t", body: "b" });
    expect(sent).toEqual(["1"]);
  });
});

describe("the email channel without an SMTP server", () => {
  it("sends nothing over the network and does not throw (development and test)", async () => {
    await expect(new EmailChannel().send({ id: "1", name: "Tolu Adeyemi", email: "tolu@example.com" }, { kind: "T", title: "Hello", body: "Body text", link: "/orders/1" })).resolves.toBeUndefined();
  });
});

describe("notification API", () => {
  async function withNotes() {
    const o = await paidOrder();
    const v = asUser(o.vendorCookies.bodija);
    return { ...o, v };
  }

  it("lists my notifications newest first, with the unread count", async () => {
    const o = await withNotes();
    await Notification.create({ userId: o.bodija.user._id, kind: "X", title: "Later one", body: "b", link: "/vendor/orders" });
    const res = await o.v.get("/notifications");
    expect(res.status).toBe(200);
    expect(res.body.data.unreadCount).toBe(2);
    expect(res.body.data.items.map((n: { title: string }) => n.title)).toEqual(["Later one", `New order ${o.bodijaSub.ref}`]);
    expect(res.body.data.items[0]).toMatchObject({ read: false, link: "/vendor/orders", kind: "X" });
  });

  it("marks one as read, and the count drops", async () => {
    const o = await withNotes();
    const id = (await o.v.get("/notifications")).body.data.items[0].id;
    const res = await o.v.post(`/notifications/${id}/read`);
    expect(res.body.data.read).toBe(true);
    expect((await o.v.get("/notifications")).body.data.unreadCount).toBe(0);
  });

  it("marks everything read", async () => {
    const o = await withNotes();
    await Notification.create({ userId: o.bodija.user._id, kind: "X", title: "Another", body: "b" });
    const res = await o.v.post("/notifications/read-all");
    expect(res.body.data.updated).toBe(2);
    expect((await o.v.get("/notifications")).body.data.unreadCount).toBe(0);
  });

  it("keeps notifications private: another user cannot read, count or clear mine", async () => {
    const o = await withNotes();
    const mineId = (await o.v.get("/notifications")).body.data.items[0].id;
    const snoop = asUser(o.customer.cookie);
    expect((await snoop.post(`/notifications/${mineId}/read`)).status).toBe(404);
    const theirs = await snoop.get("/notifications");
    expect(JSON.stringify(theirs.body)).not.toContain(o.bodijaSub.ref);
    await snoop.post("/notifications/read-all");
    expect((await o.v.get("/notifications")).body.data.unreadCount).toBe(1); // untouched
  });

  it("works for every signed-in role and needs a login", async () => {
    expect((await api().get("/api/notifications")).status).toBe(401);
    expect((await api().post("/api/notifications/read-all").set(XRW)).status).toBe(401);
    for (const role of ["CUSTOMER", "VENDOR", "ADMIN", "HANDLER"] as const) {
      await createUser(role, `${role}@example.com`);
      expect((await asUser(await loginCookie(`${role}@example.com`)).get("/notifications")).status, role).toBe(200);
    }
  });

  it("validates ids and the limit", async () => {
    const o = await withNotes();
    expect((await o.v.post("/notifications/nope/read")).status).toBe(422);
    expect((await o.v.get("/notifications?limit=0")).status).toBe(422);
    expect((await o.v.get("/notifications?limit=500")).status).toBe(422);
    expect((await o.v.get("/notifications?limit=1")).body.data.items).toHaveLength(1);
  });

  it("returns an empty list, not an error, when there is nothing", async () => {
    const o = await withNotes();
    const res = await asUser((await createHandler()).cookie).get("/notifications");
    expect(res.body.data).toEqual({ unreadCount: 0, items: [] });
    void o;
  });
});
