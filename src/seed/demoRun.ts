import { env } from "../config/env.js";
import { connectDb, disconnectDb } from "../config/db.js";
import { DEMO_EMAIL_DOMAIN, seedDemoData } from "./demo.js";

// npm run seed:demo
// Loads the demo stores, products (with Unsplash photos), a handler and a customer into the database in
// MONGODB_URI. Needs SEED_DEMO_PASSWORD in server/.env: the password the demo logins will use. It is never
// hardcoded, so pick one you are happy to share with the client. Safe to run again; existing data is kept.
async function run() {
  const password = env.SEED_DEMO_PASSWORD;
  if (!password) throw new Error("Set SEED_DEMO_PASSWORD in server/.env first (at least 8 characters, a letter and a number)");
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error("SEED_DEMO_PASSWORD needs at least 8 characters with a letter and a number");
  }

  await connectDb(env.MONGODB_URI);
  const made = await seedDemoData(password);
  console.log(`Demo data ready: ${made.users} new users, ${made.vendors} new stores, ${made.products} new products (existing ones were kept).`);
  console.log(`Logins use the password from SEED_DEMO_PASSWORD: vendor@, adire@ (stores), handler@, customer@${DEMO_EMAIL_DOMAIN}.`);
  console.log("The admin login comes from `npm run seed:admin`.");
  await disconnectDb();
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
