import { env } from "../config/env.js";
import { connectDb, disconnectDb } from "../config/db.js";
import { ensureAdmin } from "./admin.js";
import { DEMO_EMAIL_DOMAIN, seedDemoData } from "./demo.js";
import { seedDemoOrders } from "./demoOrders.js";
import { seedReferenceData } from "./reference.js";

// npm run seed
// The whole starting data set, in one go, into the database in MONGODB_URI:
//   cities and categories, the Super Admin, two approved demo stores with photographed products, a delivery
//   handler, a customer with a saved address, and nine realistic past orders (so earnings, payouts and the
//   admin dashboard have something to show).
// Safe to run again: whatever already exists is kept, nothing is duplicated, and the demo orders are only
// created once. Needs SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD and SEED_DEMO_PASSWORD in server/.env.
function strongEnough(password: string) {
  return password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

async function run() {
  const { SEED_ADMIN_EMAIL: adminEmail, SEED_ADMIN_PASSWORD: adminPassword, SEED_DEMO_PASSWORD: demoPassword } = env;
  const missing = [!adminEmail && "SEED_ADMIN_EMAIL", !adminPassword && "SEED_ADMIN_PASSWORD", !demoPassword && "SEED_DEMO_PASSWORD"].filter(Boolean);
  if (missing.length) throw new Error(`Set ${missing.join(", ")} in server/.env first`);
  if (!strongEnough(demoPassword!)) throw new Error("SEED_DEMO_PASSWORD needs at least 8 characters with a letter and a number");

  await connectDb(env.MONGODB_URI);

  await seedReferenceData();
  console.log("Cities and categories: ready");

  const admin = await ensureAdmin({ email: adminEmail!, password: adminPassword!, name: env.SEED_ADMIN_NAME });
  console.log(admin === "created" ? `Admin: created ${adminEmail}` : `Admin: password reset for ${adminEmail}`);

  const made = await seedDemoData(demoPassword!);
  console.log(`Demo data: ${made.users} new users, ${made.vendors} new stores, ${made.products} new products (existing ones were kept)`);

  const orders = await seedDemoOrders();
  console.log(orders > 0 ? `Demo orders: ${orders} created` : "Demo orders: already there, left alone");

  console.log(`\nLogins (demo password is SEED_DEMO_PASSWORD): vendor@ and adire@ (stores), handler@, customer@${DEMO_EMAIL_DOMAIN}. The admin is ${adminEmail}.`);
  await disconnectDb();
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
