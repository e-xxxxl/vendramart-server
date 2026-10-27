import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ok } from "../../utils/respond.js";
import { City, publicCity } from "../../models/City.js";
import { Category, publicCategory } from "../../models/Category.js";
export const referenceRouter = Router();
referenceRouter.get("/cities", asyncHandler(async (_req, res) => {
    const cities = await City.find().sort({ sortOrder: 1 });
    ok(res, cities.map(publicCity));
}));
referenceRouter.get("/categories", asyncHandler(async (_req, res) => {
    const categories = await Category.find().sort({ sortOrder: 1 });
    ok(res, categories.map(publicCategory));
}));
