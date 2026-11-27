import type { Request } from "express";
import { Types } from "mongoose";
import { User, type UserDoc } from "../../models/User.js";
import { Vendor, type VendorDoc } from "../../models/Vendor.js";
import { Product } from "../../models/Product.js";
import { AppError } from "../../utils/AppError.js";
import { uniqueSlug } from "../../utils/slug.js";
import { getRequireNin } from "../../models/Settings.js";
import { hashPassword } from "../auth/auth.service.js";
import { requireActiveCityForPoint } from "../cities/cities.service.js";
import type { AddStoreInput, RegisterVendorInput } from "./vendor.schemas.js";

/** The most stores one sign-in (one email) can run, and the most stores one NIN can be used for. */
export const MAX_STORES = 3;

/** The header the website sends to say which of the owner's stores it is working on. */
export const STORE_HEADER = "x-store-id";

/** Creates the login (role VENDOR) and the store profile. New vendors start PENDING until the admin approves. */
export async function registerVendor(input: RegisterVendorInput): Promise<{ user: UserDoc; vendor: VendorDoc }> {
  if (await User.exists({ email: input.email })) {
    throw AppError.conflict("An account with this email already exists. If it is a store account, sign in and add another store (up to 3).");
  }
  if (input.nin) await assertNinFree(input.nin);
  else if (await getRequireNin()) throw AppError.validation("Enter your NIN", [{ path: "nin", message: "Your NIN is 11 digits" }]);
  // Fail on a bad pin before creating anything.
  const city = await requireActiveCityForPoint(input.pickup, "pickup address");

  const user = await User.create({
    role: "VENDOR",
    name: input.ownerName,
    email: input.email,
    phone: input.phone,
    passwordHash: await hashPassword(input.password),
    emailVerified: false, // confirmed later, from the link emailed to them
  });

  try {
    const vendor = await Vendor.create({
      userId: user._id,
      businessName: input.businessName,
      slug: await uniqueSlug(Vendor, input.businessName),
      ownerName: input.ownerName,
      phone: input.phone,
      email: input.email,
      cacNumber: input.cacNumber,
      nin: input.nin,
      description: input.description,
      bank: input.bank,
      pickup: { ...input.pickup, cityId: city._id },
      status: "PENDING",
    });
    return { user, vendor };
  } catch (err) {
    // No login without a store behind it.
    await User.deleteOne({ _id: user._id });
    throw err;
  }
}

/** One NIN can back at most MAX_STORES stores. `exceptVendor` lets a vendor re-save their own. */
export async function assertNinFree(nin: string, exceptVendor?: Types.ObjectId) {
  const used = await Vendor.countDocuments({ nin, ...(exceptVendor ? { _id: { $ne: exceptVendor } } : {}) });
  if (used >= MAX_STORES) throw AppError.conflict(`This NIN is already used for ${MAX_STORES} stores, the most it can be used for. Contact support if you think this is a mistake.`);
}

/** The signed-in owner's stores, oldest first, so the first is always the one they opened with. */
export const storesOf = (userId: Types.ObjectId) => Vendor.find({ userId }).sort({ createdAt: 1, _id: 1 });

export async function assertCanAddStore(userId: Types.ObjectId) {
  if ((await Vendor.countDocuments({ userId })) >= MAX_STORES) {
    throw AppError.conflict(`One account can run up to ${MAX_STORES} stores, and you already have ${MAX_STORES}.`);
  }
}

/**
 * Opens another store for an owner who already has a sign-in. Their name, email and phone are theirs already; the new store
 * starts PENDING and waits for approval like any other. If no NIN is given, the one on their first store is used (a NIN can
 * back up to MAX_STORES stores).
 */
export async function addStore(user: UserDoc, input: AddStoreInput): Promise<VendorDoc> {
  await assertCanAddStore(user._id);
  const first = await Vendor.findOne({ userId: user._id }).sort({ createdAt: 1, _id: 1 });
  const nin = input.nin ?? first?.nin ?? undefined;
  if (nin) await assertNinFree(nin);
  else if (await getRequireNin()) throw AppError.validation("Enter your NIN", [{ path: "nin", message: "Your NIN is 11 digits" }]);
  const city = await requireActiveCityForPoint(input.pickup, "pickup address");

  const vendor = await Vendor.create({
    userId: user._id,
    businessName: input.businessName,
    slug: await uniqueSlug(Vendor, input.businessName),
    ownerName: user.name,
    phone: input.phone ?? first?.phone ?? user.phone,
    email: user.email,
    cacNumber: input.cacNumber,
    nin,
    description: input.description,
    bank: input.bank,
    pickup: { ...input.pickup, cityId: city._id },
    status: "PENDING",
  });
  // Several adds at the same moment could each pass the check above. The stores are ranked by id, and one ranked past the limit
  // steps back out, so exactly MAX_STORES stay however the requests interleave.
  if ((await Vendor.countDocuments({ userId: user._id, _id: { $lt: vendor._id } })) >= MAX_STORES) {
    await Vendor.deleteOne({ _id: vendor._id });
    throw AppError.conflict(`One account can run up to ${MAX_STORES} stores, and you already have ${MAX_STORES}.`);
  }
  return vendor;
}

/**
 * The store this request is working on. A sign-in can own up to MAX_STORES stores; the website names the one it has open in the
 * X-Store-Id header, and with no header (or none that is theirs) it is their first store. Someone else's store id is not found,
 * the same as one that does not exist, so a vendor can never reach another owner's store this way.
 */
export async function getVendorForUser(req: Pick<Request, "user" | "headers">): Promise<VendorDoc> {
  const userId = req.user!._id;
  const asked = req.headers[STORE_HEADER];
  const id = Array.isArray(asked) ? asked[0] : asked;
  if (id) {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound("Store not found");
    const vendor = await Vendor.findOne({ _id: id, userId });
    if (!vendor) throw AppError.notFound("Store not found");
    return vendor;
  }
  const vendor = await Vendor.findOne({ userId }).sort({ createdAt: 1, _id: 1 });
  if (!vendor) throw AppError.notFound("Vendor profile not found");
  return vendor;
}

/** Moving the pickup pin can move the store to another city, so its products follow. */
export async function updatePickup(vendor: VendorDoc, pickup: { line: string; placeId?: string; lat: number; lng: number }) {
  const city = await requireActiveCityForPoint(pickup, "pickup address");
  vendor.pickup = { ...pickup, cityId: city._id } as VendorDoc["pickup"];
  await vendor.save();
  await Product.updateMany({ vendorId: vendor._id }, { cityId: city._id });
  return vendor;
}
