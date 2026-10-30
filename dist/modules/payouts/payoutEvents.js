import { User } from "../../models/User.js";
import { getNotifier } from "../../services/notifications/index.js";
import { formatNaira } from "../../utils/formatNaira.js";
import { adminPayoutPage } from "../../utils/webLinks.js";
const toRecipient = (u) => ({ id: String(u._id), name: u.name, email: u.email });
const send = (to, m) => (to.length ? getNotifier().notify(to.map(toRecipient), m) : Promise.resolve());
/** A notification problem must never break the money action that caused it. */
async function safely(work) {
    try {
        await work();
    }
    catch (err) {
        console.error("Payout notification failed:", err.message);
    }
}
export const notifyPayoutRequested = (payout, vendor) => safely(async () => send(await User.find({ role: "ADMIN", isActive: true }), {
    kind: "PAYOUT_REQUESTED",
    title: `Payout request ${payout.number}`,
    body: `${vendor.businessName} asked for ${formatNaira(payout.amountKobo)} across ${payout.subOrderIds.length} ${payout.subOrderIds.length === 1 ? "order" : "orders"}.`,
    link: adminPayoutPage(payout._id),
}));
export const notifyPayoutPaid = (payout, vendor) => safely(async () => {
    const owner = await User.findById(vendor.userId);
    if (owner) {
        await send([owner], {
            kind: "PAYOUT_PAID",
            title: `Payout ${payout.number} paid`,
            body: `${formatNaira(payout.amountKobo)} has been transferred to ${payout.bank.bankName}. The transfer receipt is on your earnings page.`,
            link: "/vendor/earnings",
        });
    }
});
export const notifyPayoutDeclined = (payout, vendor) => safely(async () => {
    const owner = await User.findById(vendor.userId);
    if (owner) {
        await send([owner], {
            kind: "PAYOUT_DECLINED",
            title: `Payout ${payout.number} declined`,
            body: `Reason: ${payout.declineReason}. The ${formatNaira(payout.amountKobo)} is back in your available balance.`,
            link: "/vendor/earnings",
        });
    }
});
