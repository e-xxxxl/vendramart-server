import { InAppChannel } from "../src/services/notifications/channels.js";
import { NotificationService, setNotifier, type NotificationChannel, type NotificationMessage, type Recipient } from "../src/services/notifications/index.js";
import { Order } from "../src/models/Order.js";
import { SubOrder, type SubOrderDoc } from "../src/models/SubOrder.js";
import { api, createUser, loginCookie, XRW } from "./helpers.js";
import { chargeSuccess, placeOrder, sendWebhook, twoVendorScenario } from "./paymentHelpers.js";

/** Stands in for the email channel: remembers what would have been sent, optionally fails. */
export class RecordingChannel implements NotificationChannel {
  readonly name = "recording";
  sent: { to: Recipient; message: NotificationMessage }[] = [];
  failWith: Error | null = null;
  async send(to: Recipient, message: NotificationMessage) {
    if (this.failWith) throw this.failWith;
    this.sent.push({ to, message });
  }
  reset() {
    this.sent = [];
    this.failWith = null;
  }
  /** Messages sent to one address. */
  to(email: string) {
    return this.sent.filter((s) => s.to.email === email).map((s) => s.message);
  }
}

export const emailLog = new RecordingChannel();
// Real in-app notifications (stored in the database) plus the recording stand-in for email.
setNotifier(new NotificationService([new InAppChannel(), emailLog]));

export const asUser = (cookie: string) => ({
  get: (path: string) => api().get(`/api${path}`).set("Cookie", cookie),
  post: (path: string, body?: unknown) => api().post(`/api${path}`).set(XRW).set("Cookie", cookie).send((body ?? {}) as object),
  patch: (path: string, body?: unknown) => api().patch(`/api${path}`).set(XRW).set("Cookie", cookie).send((body ?? {}) as object),
  put: (path: string, body?: unknown) => api().put(`/api${path}`).set(XRW).set("Cookie", cookie).send((body ?? {}) as object),
  delete: (path: string) => api().delete(`/api${path}`).set(XRW).set("Cookie", cookie),
});

export async function createHandler(email = "rider@example.com") {
  const user = await createUser("HANDLER", email);
  return { user, email, cookie: await loginCookie(email) };
}

export async function createAdmin(email = "admin@example.com") {
  const user = await createUser("ADMIN", email);
  return { user, email, cookie: await loginCookie(email) };
}

/**
 * The checkout-screen order, placed AND paid through the real webhook, so the sub-orders are PAID,
 * ready for a vendor to pack. Notification and email logs are cleared so tests see only what happens next.
 */
export async function paidOrder() {
  const s = await twoVendorScenario();
  const placed = await placeOrder(s.customer, s.items);
  const res = await sendWebhook(chargeSuccess(placed.data.reference));
  if (res.status !== 200) throw new Error(`webhook failed: ${res.status}`);
  const subs = await SubOrder.find({ orderId: placed.order._id }).sort({ ref: 1 });
  const bodijaSub = subs.find((x) => String(x.vendorId) === String(s.bodija.vendor._id))!;
  const ojabaSub = subs.find((x) => String(x.vendorId) === String(s.ojaba.vendor._id))!;
  const vendorCookies = {
    bodija: await loginCookie(s.bodija.email),
    ojaba: await loginCookie(s.ojaba.email),
  };
  return { ...s, ...placed, subs, bodijaSub, ojabaSub, vendorCookies };
}

export const reload = (sub: SubOrderDoc) => SubOrder.findById(sub._id).then((x) => x!);
export const reloadOrder = (id: unknown) => Order.findById(id).then((x) => x!);
