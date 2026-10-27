import { productPlaceholder } from "../../config/placeholderImages.js";
import { Category } from "../../models/Category.js";
import { Product } from "../../models/Product.js";
import { visibleVendors } from "../products/catalog.service.js";
export const MAX_QTY = 99;
/** Merges repeats of the same product (summing, capped) and keeps first-seen order. */
function mergeItems(items) {
    const merged = new Map();
    for (const { productId, qty } of items)
        merged.set(productId, Math.min(MAX_QTY, (merged.get(productId) ?? 0) + qty));
    return [...merged.entries()].map(([productId, qty]) => ({ productId, qty }));
}
/**
 * Re-reads every product from the database: is it still for sale, at what price, how many are left.
 * A product that is hidden, deleted, or from an unapproved or suspended store, or from a city that
 * is not live, comes back UNAVAILABLE and its details are not revealed.
 */
export async function resolveCart(items) {
    const wanted = mergeItems(items);
    if (wanted.length === 0)
        return [];
    const [products, vendors] = await Promise.all([Product.find({ _id: { $in: wanted.map((w) => w.productId) } }), visibleVendors()]);
    const categories = await Category.find({ _id: { $in: [...new Set(products.map((p) => String(p.categoryId)))] } }).select("slug");
    const slugOf = new Map(categories.map((c) => [String(c._id), c.slug]));
    const byProduct = new Map(products.map((p) => [String(p._id), p]));
    const byVendor = new Map(vendors.map((v) => [String(v._id), v]));
    return wanted.map(({ productId, qty }) => {
        const product = byProduct.get(productId);
        const vendor = product ? byVendor.get(String(product.vendorId)) : undefined;
        if (!product || !product.isActive || !vendor)
            return { productId, qty, status: "UNAVAILABLE", maxQty: 0 };
        const maxQty = Math.min(product.stock, MAX_QTY);
        const status = product.stock === 0 ? "OUT_OF_STOCK" : qty > product.stock ? "LOW_STOCK" : "OK";
        return {
            productId,
            qty,
            status,
            maxQty,
            vendorDoc: vendor,
            product: {
                slug: product.slug,
                name: product.name,
                image: product.images[0]?.url ?? productPlaceholder(slugOf.get(String(product.categoryId))),
                priceKobo: product.priceKobo,
                vendorId: String(vendor._id),
                vendor: { slug: vendor.slug, businessName: vendor.businessName },
            },
        };
    });
}
/** What the browser is allowed to see about a resolved line. */
export const presentLine = (l) => ({
    productId: l.productId,
    qty: l.qty,
    status: l.status,
    maxQty: l.maxQty,
    ...(l.product ? { slug: l.product.slug, name: l.product.name, image: l.product.image, priceKobo: l.product.priceKobo, vendor: l.product.vendor } : {}),
});
