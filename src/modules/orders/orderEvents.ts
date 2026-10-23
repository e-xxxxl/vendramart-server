import type { OrderDoc } from "../../models/Order.js";
import type { SubOrderDoc } from "../../models/SubOrder.js";
import { User, type UserDoc } from "../../models/User.js";
import { Vendor, type VendorDoc } from "../../models/Vendor.js";
import { getNotifier, type NotificationMessage, type Recipient } from "../../services/notifications/index.js";

export type SubOrderEvent = "READY_FOR_PICKUP" | "ASSIGNED" | "PICKED_UP" | "DELIVERED" | "FAILED_DELIVERY" | "CANCELLED";

const toRecipient = (u: UserDoc): Recipient => ({ id: String(u._id), name: u.name, email: u.email });
const send = (to: UserDoc[], message: NotificationMessage) => (to.length ? getNotifier().notify(to.map(toRecipient), message) : Promise.resolve());

async function admins(): Promise<UserDoc[]> {
  return User.find({ role: "ADMIN", isActive: true });
}

async function parties(sub: SubOrderDoc) {
  const [customer, vendor, handler] = await Promise.all([
    User.findById(sub.customerId),
    Vendor.findById(sub.vendorId),
    sub.handlerId ? User.findById(sub.handlerId) : Promise.resolve(null),
  ]);
  const vendorUser = vendor ? await User.findById(vendor.userId) : null;
  return { customer, vendor: vendor as VendorDoc | null, vendorUser, handler };
}

/** A notification problem must never break the order action that caused it. */
async function safely(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (err) {
    console.error("Order notification failed:", (err as Error).message);
  }
}

/**
 * One payment can confirm several deliveries. The customer hears about it once, each vendor hears about
 * their own part, and the admin hears that deliveries now need handlers.
 */
export function notifyOrderPaid(order: OrderDoc, paidSubs: SubOrderDoc[]) {
  return safely(async () => {
    const customer = await User.findById(order.customerId);
    const names = new Map((await Vendor.find({ _id: { $in: paidSubs.map((s) => s.vendorId) } })).map((v) => [String(v._id), v]));

    if (customer) {
      await send([customer], {
        kind: "ORDER_PAID",
        title: "Payment received",
        body: `Order ${order.orderNumber} is confirmed. ${paidSubs.length === 1 ? "The vendor is" : `${paidSubs.length} vendors are`} getting your items ready.`,
        link: `/orders/${order._id}`,
      });
    }
    for (const sub of paidSubs) {
      const vendor = names.get(String(sub.vendorId));
      const vendorUser = vendor ? await User.findById(vendor.userId) : null;
      const units = sub.items.reduce((n, i) => n + i.qty, 0);
      if (vendorUser) {
        await send([vendorUser], {
          kind: "NEW_ORDER",
          title: `New order ${sub.ref}`,
          body: `${units} ${units === 1 ? "item" : "items"} to prepare. Mark it ready for pickup when it is packed.`,
          link: "/vendor/orders",
        });
      }
    }
    await send(await admins(), {
      kind: "ORDER_NEEDS_HANDLER",
      title: `Order ${order.orderNumber} paid`,
      body: `${paidSubs.length} ${paidSubs.length === 1 ? "delivery needs" : "deliveries need"} a handler.`,
      link: "/admin/deliveries",
    });
  });
}

/** Status changes and assignments on one delivery. `actor` is skipped so nobody is told about their own click. */
export function notifySubOrderEvent(sub: SubOrderDoc, event: SubOrderEvent, opts: { actorId?: string; reason?: string } = {}) {
  return safely(async () => {
    const { customer, vendor, vendorUser, handler } = await parties(sub);
    const notSelf = (u: UserDoc | null): UserDoc[] => (u && String(u._id) !== opts.actorId ? [u] : []);
    const from = vendor?.businessName ?? "the vendor";
    const orderLink = `/orders/${sub.orderId}`;

    switch (event) {
      case "READY_FOR_PICKUP":
        await send(notSelf(customer), { kind: "READY_FOR_PICKUP", title: "Your items are ready", body: `${from} has packed ${sub.ref} and it is waiting for a rider.`, link: orderLink });
        if (handler) {
          await send(notSelf(handler), { kind: "READY_FOR_PICKUP", title: `${sub.ref} is ready to collect`, body: `Pick up from ${from}: ${sub.delivery!.pickup!.line}.`, link: `/handler/${sub._id}` });
        } else {
          await send(await admins(), { kind: "READY_UNASSIGNED", title: `${sub.ref} is ready but has no handler`, body: `${from} has it packed. Assign a delivery handler.`, link: "/admin/deliveries" });
        }
        break;

      case "ASSIGNED":
        await send(notSelf(handler), {
          kind: "DELIVERY_ASSIGNED",
          title: `New delivery ${sub.ref}`,
          body: `Collect from ${from} (${sub.delivery!.pickup!.line}) and deliver to ${sub.delivery!.dropoff!.line}.`,
          link: `/handler/${sub._id}`,
        });
        await send(notSelf(vendorUser), { kind: "HANDLER_ASSIGNED", title: `Rider assigned to ${sub.ref}`, body: "A delivery handler will collect this order when it is ready.", link: "/vendor/orders" });
        break;

      case "PICKED_UP":
        await send(notSelf(customer), { kind: "PICKED_UP", title: "On its way", body: `${sub.ref} from ${from} has been picked up and is heading to you.`, link: orderLink });
        await send(notSelf(vendorUser), { kind: "PICKED_UP", title: `${sub.ref} picked up`, body: "The rider has collected this order.", link: "/vendor/orders" });
        break;

      case "DELIVERED":
        await send(notSelf(customer), { kind: "DELIVERED", title: "Delivered", body: `${sub.ref} from ${from} has been delivered. Enjoy!`, link: orderLink });
        await send(notSelf(vendorUser), { kind: "DELIVERED", title: `${sub.ref} delivered`, body: "Your earnings for this order unlock 24 hours after delivery.", link: "/vendor/earnings" });
        break;

      case "FAILED_DELIVERY":
        await send(notSelf(customer), { kind: "FAILED_DELIVERY", title: "We could not deliver your order", body: `${sub.ref}: ${opts.reason ?? "the delivery was not completed"}. We will contact you.`, link: orderLink });
        await send(notSelf(vendorUser), { kind: "FAILED_DELIVERY", title: `${sub.ref} delivery failed`, body: opts.reason ?? "The delivery was not completed.", link: "/vendor/orders" });
        await send(await admins(), { kind: "FAILED_DELIVERY", title: `${sub.ref} delivery failed`, body: opts.reason ?? "The handler reported a failed delivery.", link: "/admin/deliveries" });
        break;

      case "CANCELLED":
        await send(notSelf(customer), { kind: "CANCELLED", title: "Part of your order was cancelled", body: `${sub.ref} from ${from} was cancelled. We will be in touch about a refund.`, link: orderLink });
        await send(notSelf(vendorUser), { kind: "CANCELLED", title: `${sub.ref} was cancelled`, body: "This order will not go ahead.", link: "/vendor/orders" });
        break;
    }
  });
}
