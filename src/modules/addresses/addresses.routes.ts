import { Router } from "express";
import type { Types } from "mongoose";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { created, ok } from "../../utils/respond.js";
import { objectId } from "../../utils/zodCommon.js";
import { Address, publicAddress, type AddressDoc } from "../../models/Address.js";
import { City } from "../../models/City.js";
import { addressInput } from "../auth/auth.schemas.js";
import { findCityForPoint } from "../cities/cities.service.js";

// Mounted under /api/me/addresses behind requireRole("CUSTOMER"). Every query is scoped to the signed-in user.
export const addressesRouter = Router();

const MAX_ADDRESSES = 10;
const createSchema = addressInput.extend({ isDefault: z.boolean().optional() });
const updateSchema = addressInput.partial().extend({ isDefault: z.boolean().optional() }).strict();
const idParams = z.object({ id: objectId });

async function present(addresses: AddressDoc[]) {
  const cityIds = [...new Set(addresses.map((a) => a.cityId).filter(Boolean).map(String))];
  const cities = await City.find({ _id: { $in: cityIds } });
  const byId = new Map(cities.map((c) => [String(c._id), c]));
  return addresses.map((a) => {
    const city = a.cityId ? byId.get(String(a.cityId)) : undefined;
    return { ...publicAddress(a), city: city ? { id: String(city._id), name: city.name, isActive: city.isActive } : null };
  });
}

async function findOwn(userId: Types.ObjectId, id: string) {
  const address = await Address.findOne({ _id: id, userId });
  if (!address) throw AppError.notFound("Address not found");
  return address;
}

/** Makes exactly one address the default. */
async function makeDefault(userId: Types.ObjectId, id: Types.ObjectId) {
  await Address.updateMany({ userId, _id: { $ne: id } }, { isDefault: false });
  await Address.updateOne({ _id: id }, { isDefault: true });
}

addressesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    // Default first, then newest.
    const list = await Address.find({ userId: req.user!._id }).sort({ isDefault: -1, createdAt: -1 });
    ok(res, await present(list));
  }),
);

addressesRouter.post(
  "/",
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    const userId = req.user!._id;
    if ((await Address.countDocuments({ userId })) >= MAX_ADDRESSES) {
      throw AppError.validation(`You can save up to ${MAX_ADDRESSES} addresses. Delete one to add another.`);
    }
    const { lat, lng, isDefault, ...rest } = req.validated.body;
    const city = await findCityForPoint({ lat, lng });
    const first = (await Address.countDocuments({ userId })) === 0;

    const address = await Address.create({ ...rest, userId, location: { lat, lng }, cityId: city?._id, isDefault: false });
    if (first || isDefault) await makeDefault(userId, address._id);
    created(res, (await present([(await Address.findById(address._id))!]))[0]);
  }),
);

addressesRouter.patch(
  "/:id",
  validate({ params: idParams, body: updateSchema }),
  asyncHandler(async (req, res) => {
    const address = await findOwn(req.user!._id, req.validated.params.id);
    const { lat, lng, isDefault, ...rest } = req.validated.body;
    Object.assign(address, rest);

    // Moving the pin can change the city, so it is always recomputed together.
    if (lat !== undefined || lng !== undefined) {
      const point = { lat: lat ?? address.location!.lat, lng: lng ?? address.location!.lng };
      address.location = point;
      address.cityId = (await findCityForPoint(point))?._id;
    }
    await address.save();
    if (isDefault === true) await makeDefault(req.user!._id, address._id);
    ok(res, (await present([(await Address.findById(address._id))!]))[0]);
  }),
);

addressesRouter.delete(
  "/:id",
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const userId = req.user!._id;
    const address = await findOwn(userId, req.validated.params.id);
    await address.deleteOne();
    // Never leave the book without a default.
    if (address.isDefault) {
      const next = await Address.findOne({ userId }).sort({ createdAt: -1 });
      if (next) await makeDefault(userId, next._id);
    }
    ok(res, { deleted: true });
  }),
);
