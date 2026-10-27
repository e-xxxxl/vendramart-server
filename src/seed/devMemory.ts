// Runs the API against a throwaway in-memory MongoDB with the demo stores loaded, so the app can be
// exercised before an Atlas URI is configured. Data is lost on exit. Never used in production.
//   npm run dev:memory -w server
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";

const cached = path.join(os.homedir(), ".cache", "mongodb-binaries", "mongod-x64-win32-6.0.19.exe");
if (!process.env.MONGOMS_SYSTEM_BINARY && fs.existsSync(cached)) process.env.MONGOMS_SYSTEM_BINARY = cached;

// A slow machine (antivirus scanning mongod on its first start) can take longer than the default 10 seconds.
const mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
process.env.MONGODB_URI = mongod.getUri("vendramart_dev");
process.env.JWT_SECRET ??= "dev-memory-secret-dev-memory-secret-0123456789";
process.env.NODE_ENV ??= "development";

// Imported after env is set, because config/env.ts reads process.env at import time.
const { connectDb } = await import("../config/db.js");
await connectDb(process.env.MONGODB_URI);
const { User } = await import("../models/User.js");
const { hashPassword } = await import("../modules/auth/auth.service.js");
const { seedDemoData } = await import("./demo.js");
const { seedDemoOrders } = await import("./demoOrders.js");

const PASSWORD = "Passw0rd123";
await User.create({ role: "ADMIN", name: "Super Admin", email: "admin@vendramart.test", phone: "08030000000", passwordHash: await hashPassword(PASSWORD) });

// Two approved stores with photographed products, a handler, and a customer with a saved address.
const made = await seedDemoData(PASSWORD);
const orders = await seedDemoOrders(); // a few past orders, so earnings and the admin dashboard are not empty
console.log(`Dev data ready (password for every account: ${PASSWORD}): admin@, vendor@ (Bodija Provisions), adire@ (Adire House), handler@, customer@vendramart.test`);
console.log(`${made.vendors} stores, ${made.products} products and ${orders} past orders loaded, with Unsplash stand-in photos.`);

await import("../server.js");

const stop = async () => {
  await mongod.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
