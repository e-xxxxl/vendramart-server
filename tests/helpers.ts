import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { createApp } from "../src/app.js";
import { User, type Role } from "../src/models/User.js";
import { hashPassword } from "../src/modules/auth/auth.service.js";
import { Vendor, type VendorDoc, type VendorStatus } from "../src/models/Vendor.js";
import { Product } from "../src/models/Product.js";
import { City } from "../src/models/City.js";
import { Category } from "../src/models/Category.js";
import { seedReferenceData } from "../src/seed/reference.js";
import { setImageStorage, type ImageStorage } from "../src/services/storage/index.js";

// Normally the whole run shares one mongod (tests/globalSetup.ts) and each file gets its own database.
// Without it (for example a runner that skips global setup) the file starts a mongod of its own.
let ownMongod: MongoMemoryServer | undefined;
let ownDatabase = false;

export async function startDb() {
  const shared = process.env.TEST_MONGO_URI;
  if (shared) {
    ownDatabase = true;
    await mongoose.connect(`${shared}vendramart_test_${process.pid}_${Date.now().toString(36)}`);
  } else {
    ownMongod = await MongoMemoryServer.create();
    await mongoose.connect(ownMongod.getUri("vendramart_test"));
  }
  await User.init();
}

export async function stopDb() {
  if (ownDatabase) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await ownMongod?.stop();
}

export async function clearDb() {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

/** Fake image storage so tests never touch disk or Cloudinary. */
export class MemoryStorage implements ImageStorage {
  files = new Map<string, Buffer>();
  async upload(buffer: Buffer, { folder }: { folder: string }) {
    const publicId = `${folder}/${this.files.size + 1}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    this.files.set(publicId, buffer);
    return { url: `https://img.test/${publicId}`, publicId };
  }
  async remove(publicId: string) {
    this.files.delete(publicId);
  }
}
export const memoryStorage = new MemoryStorage();
setImageStorage(memoryStorage);

export const app = createApp();
export const api = () => request(app);

/** Header every state-changing request must carry (CSRF guard). */
export const XRW = { "X-Requested-With": "vendramart" };

export const PASSWORD = "Passw0rdTest";

export const customerBody = (over: Record<string, unknown> = {}) => ({
  name: "Tolu Adeyemi",
  email: "tolu@example.com",
  phone: "08034127781",
  password: PASSWORD,
  address: {
    line: "12 Awolowo Avenue, Old Bodija, Ibadan",
    landmark: "opposite Bodija Market gate",
    lat: 7.4318,
    lng: 3.9144,
  },
  ...over,
});

/** Creates a user directly in the DB with any role (vendors/admins/handlers have no public signup yet). */
export async function createUser(role: Role, email = `${role.toLowerCase()}@example.com`) {
  return User.create({
    role,
    name: `${role} User`,
    email,
    phone: "08030000000",
    passwordHash: await hashPassword(PASSWORD),
  });
}

/** Logs in via the real endpoint and returns the Set-Cookie header value for reuse. */
export async function loginCookie(email: string, password = PASSWORD): Promise<string> {
  const res = await api().post("/api/auth/login").set(XRW).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const raw = res.headers["set-cookie"] as unknown as string[];
  return raw.map((c) => c.split(";")[0]).join("; ");
}

// ---------- Phase 2 helpers ----------

export { seedReferenceData };

export const IBADAN = { lat: 7.4318, lng: 3.9144 }; // Bodija
export const OJA_BA = { lat: 7.3996, lng: 3.9055 };
export const LAGOS = { lat: 6.5244, lng: 3.3792 };
export const MID_OCEAN = { lat: 0, lng: 0 };

export const vendorBody = (over: Record<string, unknown> = {}) => ({
  ownerName: "Bola Adeyinka",
  email: "bodija@example.com",
  phone: "08031234567",
  password: PASSWORD,
  businessName: "Bodija Provisions",
  description: "Grains, flour and kitchen staples",
  cacNumber: "RC1234567",
  pickup: { line: "Bodija Market, Ibadan", ...IBADAN },
  bank: { bankName: "GTBank", accountNumber: "0123456789", accountName: "Bodija Provisions" },
  ...over,
});

/** Creates a vendor login + store straight in the DB (bypasses onboarding). */
export async function createVendor(opts: { email?: string; name?: string; status?: VendorStatus; point?: { lat: number; lng: number } } = {}) {
  const email = opts.email ?? `v${Math.random().toString(36).slice(2, 8)}@example.com`;
  const user = await createUser("VENDOR", email);
  const city = (await City.findOne({ slug: "ibadan" }))!;
  const name = opts.name ?? "Test Store";
  const vendor = await Vendor.create({
    userId: user._id,
    businessName: name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Math.random().toString(36).slice(2, 5),
    ownerName: "Owner",
    phone: "08031234567",
    email,
    bank: { bankName: "GTBank", accountNumber: "0123456789", accountName: name },
    pickup: { line: "Somewhere, Ibadan", ...(opts.point ?? IBADAN), cityId: city._id },
    status: opts.status ?? "APPROVED",
  });
  return { user, vendor, email };
}

export async function categoryId(slug = "grains-and-flour") {
  return String((await Category.findOne({ slug }))!._id);
}

export async function createProduct(vendor: VendorDoc, over: Record<string, unknown> = {}) {
  return Product.create({
    vendorId: vendor._id,
    cityId: vendor.pickup!.cityId,
    categoryId: await categoryId(),
    name: "Omosalewa Bean Flour",
    slug: "bean-flour-" + Math.random().toString(36).slice(2, 7),
    priceKobo: 1500000,
    stock: 10,
    ...over,
  });
}

export const productBody = async (over: Record<string, unknown> = {}) => ({
  name: "Garri Ijebu, white bag",
  description: "Crispy white garri",
  categoryId: await categoryId(),
  priceKobo: 1500000,
  stock: 20,
  ...over,
});

/** A minimal valid PNG header followed by filler, enough for magic-byte sniffing. */
export const pngBytes = (size = 64) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size, 1)]);

// ---------- Phase 3 helpers ----------

import { Address } from "../src/models/Address.js";
import type { LatLng } from "../src/domain/geo.js";
import type { DistanceProvider } from "../src/services/distance/index.js";
import { setDistanceProvider } from "../src/services/distance/index.js";

/** Fake road distances: fixed metres per pickup point, so tests can reproduce the checkout screen exactly. */
export class FakeDistance implements DistanceProvider {
  calls: { origin: LatLng; destination: LatLng }[] = [];
  private byOrigin = new Map<string, number>();
  fallbackMeters = 5000;
  failWith: Error | null = null;

  private key = (p: LatLng) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
  setFrom(origin: LatLng, meters: number) {
    this.byOrigin.set(this.key(origin), meters);
  }
  reset() {
    this.calls = [];
    this.byOrigin.clear();
    this.fallbackMeters = 5000;
    this.failWith = null;
  }
  async driveDistanceMeters(origin: LatLng, destination: LatLng) {
    this.calls.push({ origin, destination });
    if (this.failWith) throw this.failWith;
    return this.byOrigin.get(this.key(origin)) ?? this.fallbackMeters;
  }
}
export const fakeDistance = new FakeDistance();
setDistanceProvider(fakeDistance);

export const CUSTOMER_HOME = { lat: 7.4, lng: 3.92 }; // somewhere in Ibadan

/** A signed-in customer with one default saved address in Ibadan. */
export async function createCustomer(opts: { email?: string; point?: LatLng; cityId?: mongoose.Types.ObjectId | null } = {}) {
  const email = opts.email ?? `c${Math.random().toString(36).slice(2, 8)}@example.com`;
  const user = await createUser("CUSTOMER", email);
  const ibadan = (await City.findOne({ slug: "ibadan" }))!;
  const address = await Address.create({
    userId: user._id,
    label: "Home",
    line: "12 Awolowo Avenue, Old Bodija, Ibadan",
    landmark: "opposite Bodija Market gate",
    location: opts.point ?? CUSTOMER_HOME,
    cityId: opts.cityId === undefined ? ibadan._id : opts.cityId,
    isDefault: true,
  });
  const cookie = await loginCookie(email);
  return { user, address, cookie, email };
}

export const quoteReq = (cookie: string, body: unknown) => api().post("/api/checkout/quote").set(XRW).set("Cookie", cookie).send(body as object);
