import { earningState, unlockedBefore } from "../../domain/earnings.js";
import { Payout } from "../../models/Payout.js";
import { SubOrder } from "../../models/SubOrder.js";
/** Statuses that can hold or have held vendor money. PENDING_PAYMENT and CANCELLED never do. */
const EARNING_STATUSES = ["PAID", "READY_FOR_PICKUP", "PICKED_UP", "FAILED_DELIVERY", "DELIVERED", "COMPLETED"];
/** Delivered orders, whether or not the sweeper has moved them on to COMPLETED yet. */
const DELIVERED_STATUSES = ["DELIVERED", "COMPLETED"];
/** Ids of this vendor's declined payouts. Their orders are free again even if the unlock step never ran. */
export async function declinedPayoutIds(vendorId) {
    return (await Payout.find({ vendorId, status: "DECLINED" }).select("_id")).map((p) => p._id);
}
/**
 * THE definition of "available to withdraw", as a database filter: delivered, the 4 working day hold passed, and not locked in a
 * live payout. Both the payout request and the earnings page use it. It is the query form of
 * `earningState(...) === "AVAILABLE"` (a test keeps the two identical), and it looks only at timestamps and the
 * payout link: no job has to have run.
 */
export function availableFilter(vendorId, now, declined) {
    return {
        vendorId,
        status: { $in: DELIVERED_STATUSES },
        deliveredAt: { $lte: unlockedBefore(now) },
        $or: [{ payoutId: null }, { payoutId: { $in: declined } }],
    };
}
export async function loadEarnings(vendorId, now = new Date()) {
    const subs = await SubOrder.find({ vendorId, status: { $in: EARNING_STATUSES } }).sort({ paidAt: -1, createdAt: -1 });
    const payoutIds = [...new Set(subs.map((s) => s.payoutId).filter(Boolean).map(String))];
    const payouts = payoutIds.length ? await Payout.find({ _id: { $in: payoutIds } }).select("status") : [];
    const payoutStatus = new Map(payouts.map((p) => [String(p._id), p.status]));
    const summary = {
        availableKobo: 0, availableOrders: 0, onHoldKobo: 0, onHoldOrders: 0, nextUnlockAt: null,
        awaitingKobo: 0, awaitingOrders: 0, awaitingOutForDelivery: 0, requestedKobo: 0, paidKobo: 0,
    };
    const results = new Map();
    for (const s of subs) {
        const result = earningState({ status: s.status, deliveredAt: s.deliveredAt, payoutStatus: s.payoutId ? payoutStatus.get(String(s.payoutId)) : null }, now);
        results.set(String(s._id), result);
        const earn = s.vendorEarningKobo;
        switch (result.state) {
            case "AVAILABLE":
                summary.availableKobo += earn;
                summary.availableOrders++;
                break;
            case "ON_HOLD":
                summary.onHoldKobo += earn;
                summary.onHoldOrders++;
                if (result.unlocksAt && (!summary.nextUnlockAt || result.unlocksAt < summary.nextUnlockAt))
                    summary.nextUnlockAt = result.unlocksAt;
                break;
            case "AWAITING_DELIVERY":
                summary.awaitingKobo += earn;
                summary.awaitingOrders++;
                if (s.status === "PICKED_UP")
                    summary.awaitingOutForDelivery++;
                break;
            case "REQUESTED":
                summary.requestedKobo += earn;
                break;
            case "PAID":
                summary.paidKobo += earn;
                break;
        }
    }
    return { subs, results, summary };
}
/** One row per item, as on the vendor earnings screen. The state is shared by every item of the same sub-order. */
export function toRows(subs, results) {
    return subs.flatMap((s) => {
        const r = results.get(String(s._id));
        return s.items.map((i) => ({
            subOrderId: String(s._id),
            ref: s.ref,
            orderStatus: s.status,
            item: i.name,
            qty: i.qty,
            deliveredAt: s.deliveredAt ?? null,
            saleKobo: i.lineTotalKobo,
            feeKobo: i.commissionKobo,
            earnKobo: i.vendorEarningKobo,
            state: r.state,
            unlocksAt: r.unlocksAt ?? null,
        }));
    });
}
