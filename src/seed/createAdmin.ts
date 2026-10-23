import { env } from "../config/env.js";
import { connectDb, disconnectDb } from "../config/db.js";
import { ensureAdmin } from "./admin.js";
import { seedReferenceData } from "./reference.js";

// npm run seed:admin
// Creates (or resets the password of) the Super Admin from SEED_ADMIN_* env vars, and makes sure the cities and
// categories exist. `npm run seed` does this and also loads the demo stores and orders.
async function run() {
  const { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password } = env;
  if (!email || !password) {
    throw new Error("Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in server/.env first");
  }

  await connectDb(env.MONGODB_URI);
  await seedReferenceData(); // cities (Ibadan live) and categories; safe to re-run
  console.log("Cities and categories are in place");
  const result = await ensureAdmin({ email, password, name: env.SEED_ADMIN_NAME });
  console.log(result === "created" ? `Admin created: ${email}` : `Admin password reset for ${email}`);
  await disconnectDb();
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
