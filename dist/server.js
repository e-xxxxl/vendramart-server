import { env } from "./config/env.js";
import { connectDb } from "./config/db.js";
import { createApp } from "./app.js";
import { User } from "./models/User.js";
import { Address } from "./models/Address.js";
import { Order } from "./models/Order.js";
import { SubOrder } from "./models/SubOrder.js";
import { WebhookEvent } from "./models/WebhookEvent.js";
import { expireStaleOrders } from "./modules/orders/orders.service.js";
import { seedReferenceData } from "./seed/reference.js";
import { completeDeliveredOrders } from "./modules/orders/subOrderTransitions.js";
async function main() {
    const conn = await connectDb(env.MONGODB_URI);
    // Make sure unique indexes (e.g. User.email, Order payment reference, webhook event keys) exist before taking traffic.
    await Promise.all([User.init(), Address.init(), Order.init(), SubOrder.init(), WebhookEvent.init()]);
    console.log(`MongoDB connected: ${conn.name}`);
    // A brand-new database has no cities or categories, and the storefront cannot work without them.
    // This only ever INSERTS missing ones (never changes an existing city's live/coming-soon setting).
    await seedReferenceData();
    const app = createApp();
    app.listen(env.PORT, () => {
        console.log(`VendraMart API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
    });
    // Unpaid orders hold stock, so release it when the payment window passes. Reads also expire on demand;
    // this just makes sure it happens even if nobody looks.
    const sweep = () => Promise.all([
        expireStaleOrders().then((n) => n > 0 && console.log(`Expired ${n} unpaid order(s) and returned their stock`)),
        // Delivered orders become COMPLETED once their 24-hour hold has passed.
        completeDeliveredOrders().then((n) => n > 0 && console.log(`Completed ${n} delivered order(s) after the 24-hour hold`)),
    ]).catch((err) => console.error("Order sweep failed:", err));
    setInterval(sweep, 60_000).unref();
}
main().catch((err) => {
    console.error("Failed to start server:", err.message ?? err);
    process.exit(1);
});
