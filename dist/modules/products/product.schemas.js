import { z } from "zod";
import { objectId, pagination } from "../../utils/zodCommon.js";
const image = z.object({
    url: z.string().trim().min(1).max(500),
    publicId: z.string().trim().min(1).max(300),
});
const base = {
    name: z.string().trim().min(2, "Enter a product name").max(140),
    description: z.string().trim().max(2000).default(""),
    categoryId: objectId,
    // Money is integer kobo (N15,000 = 1500000). The vendor form converts naira to kobo.
    priceKobo: z.number().int("Price must be a whole number of kobo").min(100, "Price must be at least N1"),
    stock: z.number().int("Stock must be a whole number").min(0, "Stock cannot be negative").max(1_000_000),
    images: z.array(image).max(5, "You can add up to 5 images").default([]),
    isActive: z.boolean().default(true),
};
export const createProductSchema = z.object(base);
export const updateProductSchema = z.object(base).partial().strict();
export const vendorListQuery = pagination.extend({
    q: z.string().trim().max(100).optional(),
});
export const idParams = z.object({ id: objectId });
export const catalogQuery = pagination.extend({
    q: z.string().trim().max(100).optional(),
    city: z.string().trim().max(60).optional(), // city slug
    category: z.string().trim().max(80).optional(), // category slug
    vendor: z.string().trim().max(140).optional(), // vendor slug
    sort: z.enum(["newest", "popular", "price_asc", "price_desc"]).default("newest"),
});
