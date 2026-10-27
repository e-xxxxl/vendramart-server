import { randomBytes } from "node:crypto";
import { calculateLineEarnings } from "../../domain/commission.js";
import { sumKobo } from "../../domain/money.js";
import { env } from "../../config/env.js";
import { nextSeq } from "../../models/Counter.js";
import { Order } from "../../models/Order.js";
import { Product } from "../../models/Product.js";
import { StatusLog } from "../../models/StatusLog.js";
import { SubOrder } from "../../models/SubOrder.js";
import { getPaymentGateway } from "../../services/payments/index.js";
import { AppError } from "../../utils/AppError.js";
import { buildQuote } from "../checkout/checkout.service.js";
/** How long stock is held for an unpaid order. */
export const ORDER_EXPIRY_MINUTES = 30;
export const ORDER_NUMBER_START = 10000; // first order is VM-10001
/** 0 -> A, 1 -> B, ... 25 -> Z, 26 -> AA. */
export function subOrderLetter(index) {
    let n = index;
    let out = "";
    do {
        out = String.fromCharCode(65 + (n % 26)) + out;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return out;
}
/** Puts reserved stock back. Best effort per product so one failure cannot strand the rest. */
export async function releaseStock(items) {
    await Promise.allSettled(items.map((i) => Product.updateOne({ _id: i.productId }, { $inc: { stock: i.qty } })));
}
/**
 * Takes stock now, so two shoppers cannot both buy the last unit. Each decrement is conditional on
 * enough stock being left, which is atomic in MongoDB. If any item fails, everything taken so far is returned.
 */
async function reserveStock(items) {
    const taken = [];
    for (const item of items) {
        const res = await Product.updateOne({ _id: item.productId, stock: { $gte: item.qty } }, { $inc: { stock: -item.qty } });
        if (res.modifiedCount !== 1) {
            await releaseStock(taken);
            throw AppError.conflict(`${item.name} just sold out or is running low. Review your cart and try again.`, [{ path: `items.${item.productId}`, message: `${item.name} is no longer available in that quantity` }]);
        }
        taken.push({ productId: item.productId, qty: item.qty });
    }
    return taken;
}
/**
 * Turns the server's own quote into a real order and starts the Paystack payment.
 * Everything that matters is snapshotted here (rates, distances, item prices, commission), so later
 * admin or vendor changes cannot alter it. Nothing is trusted from the browser except which items,
 * how many, and which saved address.
 */
export async function createOrder(user, items, addressId) {
    const quote = await buildQuote(user._id, items, addressId);
    const bps = quote.pricing.commissionBps;
    const reserved = await reserveStock(quote.legs.flatMap((l) => l.items.map((i) => ({ productId: i.productId, qty: i.qty, name: i.name }))));
    let order;
    try {
        const orderNumber = `VM-${await nextSeq("order", ORDER_NUMBER_START)}`;
        const reference = `${orderNumber}-${randomBytes(4).toString("hex").toUpperCase()}`;
        order = await Order.create({
            orderNumber,
            customerId: user._id,
            customer: { name: user.name, email: user.email, phone: user.phone },
            deliveryAddress: {
                label: quote.address.label,
                line: quote.address.line,
                landmark: quote.address.landmark ?? undefined,
                lat: quote.address.lat,
                lng: quote.address.lng,
                cityId: quote.address.city.id,
                cityName: quote.address.city.name,
            },
            itemsSubtotalKobo: quote.itemsSubtotalKobo,
            deliveryTotalKobo: quote.deliveryTotalKobo,
            totalKobo: quote.totalKobo,
            status: "PENDING_PAYMENT",
            pricing: { pricePerKmKobo: quote.pricing.pricePerKmKobo, minDeliveryFeeKobo: quote.pricing.minDeliveryFeeKobo, commissionBps: bps },
            payment: { provider: "paystack", reference, amountKobo: quote.totalKobo },
            expiresAt: new Date(Date.now() + ORDER_EXPIRY_MINUTES * 60_000),
        });
        const subOrders = await SubOrder.insertMany(quote.legs.map((leg, index) => {
            const lines = leg.items.map((i) => ({ i, ...calculateLineEarnings(i.unitPriceKobo, i.qty, bps) }));
            return {
                orderId: order._id,
                orderNumber,
                ref: `${orderNumber}-${subOrderLetter(index)}`,
                vendorId: leg.vendor.id,
                customerId: user._id,
                status: "PENDING_PAYMENT",
                items: lines.map(({ i, lineTotalKobo, commissionKobo, vendorEarningKobo }) => ({
                    productId: i.productId,
                    name: i.name,
                    image: i.image ?? undefined,
                    unitPriceKobo: i.unitPriceKobo,
                    qty: i.qty,
                    lineTotalKobo,
                    commissionKobo,
                    vendorEarningKobo,
                })),
                itemsTotalKobo: leg.itemsTotalKobo,
                commissionBps: bps,
                commissionTotalKobo: sumKobo(lines.map((l) => l.commissionKobo)),
                vendorEarningKobo: sumKobo(lines.map((l) => l.vendorEarningKobo)),
                delivery: {
                    pickup: leg.pickup,
                    dropoff: { line: quote.address.line, landmark: quote.address.landmark ?? undefined, lat: quote.address.lat, lng: quote.address.lng },
                    distanceMeters: leg.delivery.distanceMeters,
                    pricePerKmKobo: leg.delivery.pricePerKmKobo,
                    minFeeKobo: leg.delivery.minFeeKobo,
                    minFeeApplied: leg.delivery.minFeeApplied,
                    feeKobo: leg.delivery.feeKobo,
                },
            };
        }));
        await StatusLog.insertMany(subOrders.map((s) => ({ subOrderId: s._id, orderId: order._id, from: null, to: "PENDING_PAYMENT", actorId: user._id, actorRole: "CUSTOMER", note: "Order placed" })));
        try {
            const { authorizationUrl } = await getPaymentGateway().initialize({
                email: user.email,
                amountKobo: order.totalKobo,
                reference,
                callbackUrl: `${env.CLIENT_ORIGIN}/checkout/callback?reference=${encodeURIComponent(reference)}`,
                metadata: { orderId: String(order._id), orderNumber },
            });
            return { order, authorizationUrl };
        }
        catch (err) {
            // Could not start the payment: give the stock back and close the order rather than leaving it dangling.
            await cancelPendingOrder(order._id, "Payment could not be started");
            throw err;
        }
    }
    catch (err) {
        // Whatever went wrong, no stock may stay held for an order that will never be paid.
        if (!order) {
            await releaseStock(reserved);
        }
        else if (!(err instanceof AppError)) {
            const hadSubOrders = (await SubOrder.countDocuments({ orderId: order._id })) > 0;
            await cancelPendingOrder(order._id, "Order could not be completed");
            // cancelPendingOrder returns stock per sub-order; with none created, return what we reserved directly.
            if (!hadSubOrders)
                await releaseStock(reserved);
        }
        throw err;
    }
}
/**
 * Cancels an order that is still unpaid and returns its stock. The status change is guarded
 * (`status: PENDING_PAYMENT`), so if a payment lands at the same moment exactly one of the two wins.
 * Returns false when the order was not pending any more.
 */
export async function cancelPendingOrder(orderId, note) {
    const order = await Order.findOneAndUpdate({ _id: orderId, status: "PENDING_PAYMENT" }, { status: "CANCELLED" }, { returnDocument: "after" });
    if (!order)
        return false;
    const subs = await SubOrder.find({ orderId: order._id, status: "PENDING_PAYMENT" });
    await SubOrder.updateMany({ orderId: order._id, status: "PENDING_PAYMENT" }, { status: "CANCELLED" });
    await StatusLog.insertMany(subs.map((s) => ({ subOrderId: s._id, orderId: order._id, from: "PENDING_PAYMENT", to: "CANCELLED", actorRole: "SYSTEM", note })));
    await releaseStock(subs.flatMap((s) => s.items.map((i) => ({ productId: String(i.productId), qty: i.qty }))));
    return true;
}
/** Cancels every unpaid order whose payment window has passed. Called on a timer and before status reads. */
export async function expireStaleOrders(now = new Date()) {
    const stale = await Order.find({ status: "PENDING_PAYMENT", expiresAt: { $lte: now } }).select("_id").limit(200);
    let cancelled = 0;
    for (const o of stale)
        if (await cancelPendingOrder(o._id, "Payment window expired"))
            cancelled++;
    return cancelled;
}
/** Same rule for one order, so a shopper looking at a stale order sees the truth immediately. */
export async function expireIfStale(order) {
    if (order.status === "PENDING_PAYMENT" && order.expiresAt.getTime() <= Date.now()) {
        await cancelPendingOrder(order._id, "Payment window expired");
        return (await Order.findById(order._id)) ?? order;
    }
    return order;
}
