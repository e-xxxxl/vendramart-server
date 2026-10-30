import { User } from "../../models/User.js";
import { getNotifier } from "../../services/notifications/index.js";
const toRecipient = (u) => ({ id: String(u._id), name: u.name, email: u.email });
const send = (to, m) => (to.length ? getNotifier().notify(to.map(toRecipient), m) : Promise.resolve());
/** A notification problem must never break the sign-up or the admin action that caused it. */
async function safely(work) {
    try {
        await work();
    }
    catch (err) {
        console.error("Account notification failed:", err.message);
    }
}
export const notifyWelcome = (user) => safely(() => send([user], {
    kind: "WELCOME",
    title: "Welcome to VendraMart",
    body: "Your account is ready. Shop from many Ibadan vendors in one cart and pay once. The delivery fee for each vendor is shown before you pay.",
    link: "/",
}));
/** The store owner is told the application arrived, and the admins are told there is one to review. */
export const notifyVendorApplied = (owner, vendor) => safely(async () => {
    await send([owner], {
        kind: "VENDOR_APPLIED",
        title: "We received your store application",
        body: `${vendor.businessName} is waiting for approval. You can add your products now. They go live once an admin approves the store, and we will email you.`,
        link: "/vendor/",
    });
    await send(await User.find({ role: "ADMIN", isActive: true }), {
        kind: "VENDOR_PENDING",
        title: `New store to review: ${vendor.businessName}`,
        body: `${vendor.ownerName} registered ${vendor.businessName}. Check the details and approve or decline.`,
        link: `/admin/vendors/?id=${vendor._id}`,
    });
});
export const notifyVendorDecision = (vendor, decision) => safely(async () => {
    const owner = await User.findById(vendor.userId);
    if (!owner)
        return;
    await send([owner], {
        kind: decision === "APPROVED" ? "VENDOR_APPROVED" : "VENDOR_SUSPENDED",
        title: decision === "APPROVED" ? `${vendor.businessName} is live on VendraMart` : `${vendor.businessName} has been suspended`,
        body: decision === "APPROVED"
            ? "Your store is approved and customers can now see and buy your products."
            : `Your store is hidden and cannot take new orders. Reason: ${vendor.statusReason ?? "not given"}. Contact support if you think this is a mistake.`,
        link: decision === "APPROVED" ? "/vendor/products/" : "/vendor/",
    });
});
