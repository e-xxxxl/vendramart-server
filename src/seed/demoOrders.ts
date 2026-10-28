import type { Types } from "mongoose";
import { calculateLineEarnings } from "../domain/commission.js";
import { calculateDeliveryFee } from "../domain/deliveryFee.js";
import { sumKobo } from "../domain/money.js";
import type { OrderStatus } from "../domain/orderStateMachine.js";
import { City } from "../models/City.js";
import { nextSeq } from "../models/Counter.js";
import { Order } from "../models/Order.js";
import { Product } from "../models/Product.js";
import { getPricing } from "../models/Settings.js";
import { StatusLog } from "../models/StatusLog.js";
import { SubOrder } from "../models/SubOrder.js";
import { User } from "../models/User.js";
import { Vendor } from "../models/Vendor.js";
import { ORDER_NUMBER_START, subOrderLetter } from "../modules/orders/orders.service.js";
import { holdEndsAt } from "../domain/earnings.js";
import { DEMO_EMAIL_DOMAIN } from "./demo.js";
import { slugify } from "./reference.js";

// Realistic past orders for the demo customer, so a fresh database shows a working marketplace: earnings that
// are available to withdraw, some on the hold (4 working days after delivery), a delivery in progress and one waiting for a handler.
// Money comes from the same pure functions real orders use. Runs once: if the customer already has orders it does nothing.

const HOUR = 3_600_000;

/** Delivery progress of one vendor's part, in order. */
const CHAIN: OrderStatus[] = ["PAID", "READY_FOR_PICKUP", "PICKED_UP", "DELIVERED", "COMPLETED"];

interface Plan {
  /** How long ago the customer paid. */
  hoursAgo: number;
  /** Product names, with quantity. Items from different stores become separate deliveries in the one order. */
  lines: [name: string, qty: number][];
  /** How far each delivery has got: a status for every store in the order, in the order the stores first appear. */
  status: OrderStatus[];
  handler: boolean;
}

const PLANS: Plan[] = [
  { hoursAgo: 100, lines: [["Omosalewa Bean Flour", 2], ["Garri Ijebu, white bag", 1]], status: ["COMPLETED"], handler: true },
  { hoursAgo: 95, lines: [["Adire Fabric, 6 yards", 1], ["Kente Beads, set of 6", 1]], status: ["COMPLETED"], handler: true },
  { hoursAgo: 90, lines: [["Banga Palm Oil, 4L", 1], ["Adire Tote Bag", 1]], status: ["COMPLETED", "COMPLETED"], handler: true },
  { hoursAgo: 85, lines: [["Fresh tomatoes, basket", 2], ["Yam tuber", 3]], status: ["COMPLETED"], handler: true },
  { hoursAgo: 80, lines: [["Kente Wrap Dress", 1]], status: ["COMPLETED"], handler: true },
  // The first five are finished (their start is moved back until the hold has passed), so they are complete and their money is
  // available. This one was delivered about 18 hours ago, so its earnings are still on hold.
  { hoursAgo: 20, lines: [["Extra virgin olive oil, 1L", 1], ["Tie-Dye T-Shirt, free size", 2]], status: ["DELIVERED", "DELIVERED"], handler: true },
  { hoursAgo: 6, lines: [["Oloyin (Honey) Beans", 2], ["Waist Beads, set of 3", 2]], status: ["PICKED_UP", "READY_FOR_PICKUP"], handler: true },
  { hoursAgo: 3, lines: [["King's Vegetable Oil, 5L", 1]], status: ["PAID"], handler: false },
  { hoursAgo: 1, lines: [["Hand-dyed Scarf", 1], ["Brown beans, 5 kg", 1]], status: ["PAID", "PAID"], handler: true },
];

// Road distance from each store to the demo customer's address, in metres.
const DISTANCE_M: Record<string, number> = { "bodija-provisions": 3200, "adire-house": 6400 };

const actorFor = (to: OrderStatus): "VENDOR" | "HANDLER" | "SYSTEM" => (to === "READY_FOR_PICKUP" ? "VENDOR" : to === "COMPLETED" ? "SYSTEM" : "HANDLER");

/** Returns how many orders were created (0 when the demo customer already has orders or the demo stores are missing). */
export async function seedDemoOrders(now = new Date()): Promise<number> {
  const customer = await User.findOne({ email: `customer@${DEMO_EMAIL_DOMAIN}` });
  const handler = await User.findOne({ email: `handler@${DEMO_EMAIL_DOMAIN}` });
  const ibadan = await City.findOne({ slug: "ibadan" });
  if (!customer || !handler || !ibadan) return 0;
  if (await Order.exists({ customerId: customer._id })) return 0;

  const pricing = await getPricing();
  let created = 0;

  for (const plan of PLANS) {
    const products = await Promise.all(plan.lines.map(([name]) => Product.findOne({ slug: slugify(name) })));
    if (products.some((p) => !p)) continue; // the demo catalogue was changed; skip rather than invent products
    const vendors = await Vendor.find({ _id: { $in: products.map((p) => p!.vendorId) } });
    const vendorById = new Map(vendors.map((v) => [String(v._id), v]));

    // Group the lines by store, keeping the order stores first appear in.
    const legs: { vendorId: string; lines: { name: string; qty: number; unit: number; productId: Types.ObjectId; image?: string }[] }[] = [];
    plan.lines.forEach(([name, qty], i) => {
      const p = products[i]!;
      let leg = legs.find((l) => l.vendorId === String(p.vendorId));
      if (!leg) legs.push((leg = { vendorId: String(p.vendorId), lines: [] }));
      leg.lines.push({ name, qty, unit: p.priceKobo, productId: p._id, image: p.images[0]?.url });
    });

    let paidAt = new Date(now.getTime() - plan.hoursAgo * HOUR);
    // A finished order must be old enough for its hold to have ended (4 working days after delivery, which is 2 hours
    // after payment here), and how long that takes depends on the day of the week, so step back until it has.
    if (plan.status.includes("COMPLETED")) while (holdEndsAt(new Date(paidAt.getTime() + 2 * HOUR)) > now) paidAt = new Date(paidAt.getTime() - HOUR);
    const orderNumber = `VM-${await nextSeq("order", ORDER_NUMBER_START)}`;

    const built = legs.map((leg, index) => {
      const vendor = vendorById.get(leg.vendorId)!;
      const lines = leg.lines.map((l) => ({ l, ...calculateLineEarnings(l.unit, l.qty, pricing.commissionBps) }));
      const fee = calculateDeliveryFee({ distanceMeters: DISTANCE_M[vendor.slug] ?? 4000, pricePerKmKobo: pricing.pricePerKmKobo, minFeeKobo: pricing.minDeliveryFeeKobo });
      return { index, vendor, lines, fee, itemsTotalKobo: sumKobo(lines.map((x) => x.lineTotalKobo)) };
    });
    const itemsSubtotalKobo = sumKobo(built.map((b) => b.itemsTotalKobo));
    const deliveryTotalKobo = sumKobo(built.map((b) => b.fee.feeKobo));
    const totalKobo = itemsSubtotalKobo + deliveryTotalKobo;

    const order = await Order.create({
      orderNumber,
      customerId: customer._id,
      customer: { name: customer.name, email: customer.email, phone: customer.phone },
      deliveryAddress: { label: "Home", line: "12 Awolowo Avenue, Old Bodija, Ibadan", landmark: "opposite Bodija Market gate", lat: 7.4402, lng: 3.9206, cityId: ibadan._id, cityName: ibadan.name },
      itemsSubtotalKobo,
      deliveryTotalKobo,
      totalKobo,
      status: "PAID",
      pricing: { pricePerKmKobo: pricing.pricePerKmKobo, minDeliveryFeeKobo: pricing.minDeliveryFeeKobo, commissionBps: pricing.commissionBps },
      payment: { provider: "paystack", reference: `DEMO-${orderNumber}`, amountKobo: totalKobo, channel: "card", paidAt },
      expiresAt: new Date(paidAt.getTime() + 30 * 60_000),
      createdAt: paidAt,
    });

    for (const b of built) {
      const final = plan.status[b.index] ?? plan.status[0]!;
      const reached = CHAIN.slice(0, CHAIN.indexOf(final) + 1);
      // Each step happens a little after the one before it. COMPLETED is exactly when the hold ends.
      const at: Partial<Record<OrderStatus, Date>> = {
        PAID: paidAt,
        READY_FOR_PICKUP: new Date(paidAt.getTime() + 0.4 * HOUR),
        PICKED_UP: new Date(paidAt.getTime() + 0.9 * HOUR),
        DELIVERED: new Date(paidAt.getTime() + 2 * HOUR),
      };
      at.COMPLETED = holdEndsAt(at.DELIVERED!);

      const sub = await SubOrder.create({
        orderId: order._id,
        orderNumber,
        ref: `${orderNumber}-${subOrderLetter(b.index)}`,
        vendorId: b.vendor._id,
        customerId: customer._id,
        handlerId: plan.handler ? handler._id : undefined,
        status: final,
        items: b.lines.map(({ l, lineTotalKobo, commissionKobo, vendorEarningKobo }) => ({
          productId: l.productId,
          name: l.name,
          image: l.image,
          unitPriceKobo: l.unit,
          qty: l.qty,
          lineTotalKobo,
          commissionKobo,
          vendorEarningKobo,
        })),
        itemsTotalKobo: b.itemsTotalKobo,
        commissionBps: pricing.commissionBps,
        commissionTotalKobo: sumKobo(b.lines.map((x) => x.commissionKobo)),
        vendorEarningKobo: sumKobo(b.lines.map((x) => x.vendorEarningKobo)),
        delivery: {
          pickup: { line: b.vendor.pickup!.line, lat: b.vendor.pickup!.lat, lng: b.vendor.pickup!.lng },
          dropoff: { line: "12 Awolowo Avenue, Old Bodija, Ibadan", landmark: "opposite Bodija Market gate", lat: 7.4402, lng: 3.9206 },
          distanceMeters: b.fee.billedMeters,
          pricePerKmKobo: b.fee.pricePerKmKobo,
          minFeeKobo: b.fee.minFeeKobo,
          minFeeApplied: b.fee.minFeeApplied,
          feeKobo: b.fee.feeKobo,
        },
        paidAt,
        deliveredAt: reached.includes("DELIVERED") ? at.DELIVERED : undefined,
        completedAt: reached.includes("COMPLETED") ? at.COMPLETED : undefined,
        createdAt: paidAt,
      });

      // Every status change is logged with who made it and when, the same as real orders.
      await StatusLog.insertMany([
        { subOrderId: sub._id, orderId: order._id, from: null, to: "PENDING_PAYMENT", actorId: customer._id, actorRole: "CUSTOMER", note: "Order placed", at: new Date(paidAt.getTime() - 2 * 60_000) },
        { subOrderId: sub._id, orderId: order._id, from: "PENDING_PAYMENT", to: "PAID", actorRole: "SYSTEM", note: "Payment confirmed", at: paidAt },
        ...reached.slice(1).map((to, i) => ({
          subOrderId: sub._id,
          orderId: order._id,
          from: reached[i]!,
          to,
          actorId: actorFor(to) === "VENDOR" ? b.vendor.userId : actorFor(to) === "HANDLER" ? handler._id : undefined,
          actorRole: actorFor(to),
          at: at[to]!,
        })),
      ]);
    }
    created++;
  }
  return created;
}
