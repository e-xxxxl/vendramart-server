import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/config/env.js";
import { PHOTO, PLACEHOLDER_PREFIX, categoryImage, placeholderImage, productPlaceholder, unsplashUrl } from "../src/config/placeholderImages.js";
import { Category } from "../src/models/Category.js";
import { Product } from "../src/models/Product.js";
import { User } from "../src/models/User.js";
import { Vendor } from "../src/models/Vendor.js";
import { Address } from "../src/models/Address.js";
import { DEMO_EMAIL_DOMAIN, DEMO_PRODUCT_COUNT, seedDemoData } from "../src/seed/demo.js";
import { api, clearDb, createCustomer, createProduct, createVendor, fakeDistance, loginToken, memoryStorage, seedReferenceData, startDb, stopDb } from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  fakeDistance.reset();
  memoryStorage.files.clear();
});

const isUnsplash = (u: unknown) => typeof u === "string" && /^https:\/\/images\.unsplash\.com\/photo-[0-9a-z-]+\?auto=format&fit=crop&w=\d+&q=70$/.test(u);

describe("placeholder helpers", () => {
  it("builds a CDN url with a width", () => {
    expect(unsplashUrl("abc-123", 400)).toBe("https://images.unsplash.com/photo-abc-123?auto=format&fit=crop&w=400&q=70");
    expect(unsplashUrl("abc-123")).toContain("w=700");
  });

  it("has a different default product photo for every category", () => {
    const slugs = ["grains-and-flour", "oils-and-condiments", "tubers-and-produce", "beans-and-legumes", "fashion", "beauty-and-fragrance", "accessories"];
    const urls = slugs.map((s) => productPlaceholder(s));
    expect(urls.every(isUnsplash)).toBe(true);
    expect(new Set(urls).size).toBe(slugs.length); // every category looks different
  });

  it("falls back to a generic shop photo for an unknown or missing category", () => {
    expect(productPlaceholder("no-such-category")).toBe(unsplashUrl(PHOTO.groceryAisle, 700));
    expect(productPlaceholder(undefined)).toBe(unsplashUrl(PHOTO.groceryAisle, 700));
    expect(categoryImage("no-such-category")).toBe(unsplashUrl(PHOTO.groceryAisle, 600));
  });

  it("never replaces a category's own image", () => {
    expect(categoryImage("fashion", "https://cdn.example.com/own.jpg")).toBe("https://cdn.example.com/own.jpg");
  });

  it("marks stored placeholder rows so they are recognisable", () => {
    const row = placeholderImage(PHOTO.yams);
    expect(row.publicId).toBe(`${PLACEHOLDER_PREFIX}${PHOTO.yams}`);
    expect(isUnsplash(row.url)).toBe(true);
  });

  it("can be switched off with PLACEHOLDER_IMAGES=false", () => {
    const before = env.PLACEHOLDER_IMAGES;
    try {
      (env as { PLACEHOLDER_IMAGES?: string }).PLACEHOLDER_IMAGES = "false";
      expect(productPlaceholder("fashion")).toBeNull();
      expect(categoryImage("fashion")).toBeNull();
      expect(categoryImage("fashion", "https://cdn.example.com/own.jpg")).toBe("https://cdn.example.com/own.jpg");
    } finally {
      (env as { PLACEHOLDER_IMAGES?: string }).PLACEHOLDER_IMAGES = before;
    }
  });
});

describe("storefront images", () => {
  it("gives a product with no photo a stand-in that matches its category, in listings and on its page", async () => {
    const v = await createVendor({ name: "Live Store" });
    const p = await createProduct(v.vendor, { slug: "no-photo" });
    const list = await api().get("/api/products");
    expect(isUnsplash(list.body.data[0].image)).toBe(true);
    expect(list.body.data[0].image).toBe(productPlaceholder("grains-and-flour"));

    const page = await api().get(`/api/products/${p.slug}`);
    expect(page.body.data.images).toEqual([productPlaceholder("grains-and-flour")]);
    expect(page.body.data.image).toBe(productPlaceholder("grains-and-flour"));
  });

  it("always prefers the vendor's own photos", async () => {
    const v = await createVendor({ name: "Live Store" });
    const real = [{ url: "https://img.test/real-1.jpg", publicId: `vendors/${v.vendor._id}/products/real-1` }, { url: "https://img.test/real-2.jpg", publicId: `vendors/${v.vendor._id}/products/real-2` }];
    const p = await createProduct(v.vendor, { slug: "has-photo", images: real });
    const list = await api().get("/api/products");
    expect(list.body.data[0].image).toBe("https://img.test/real-1.jpg");
    const page = await api().get(`/api/products/${p.slug}`);
    expect(page.body.data.images).toEqual(["https://img.test/real-1.jpg", "https://img.test/real-2.jpg"]);
  });

  it("gives every category a tile image on /categories and /home", async () => {
    const cats = await api().get("/api/categories");
    expect(cats.body.data).toHaveLength(7);
    expect(cats.body.data.every((c: { image: string }) => isUnsplash(c.image))).toBe(true);
    const home = await api().get("/api/home?city=ibadan");
    expect(home.body.data.categories.every((c: { image: string }) => isUnsplash(c.image))).toBe(true);
  });

  it("keeps a category's own image when it has one", async () => {
    await Category.updateOne({ slug: "fashion" }, { image: "https://cdn.example.com/fashion.jpg" });
    const cats = await api().get("/api/categories");
    expect(cats.body.data.find((c: { slug: string }) => c.slug === "fashion").image).toBe("https://cdn.example.com/fashion.jpg");
  });

  it("shows the stand-in in the cart and at checkout too, and keeps it on the placed order", async () => {
    const v = await createVendor({ name: "Live Store" });
    fakeDistance.setFrom({ lat: 7.4318, lng: 3.9144 }, 3200);
    const p = await createProduct(v.vendor, { slug: "cart-thing", categoryId: (await Category.findOne({ slug: "fashion" }))!._id });
    const cart = await api().post("/api/cart/validate").send({ items: [{ productId: String(p._id), qty: 1 }] });
    expect(cart.body.data.lines[0].image).toBe(productPlaceholder("fashion"));

    const c = await createCustomer();
    const quote = await api().post("/api/checkout/quote").set("Authorization", c.bearer).send({ items: [{ productId: String(p._id), qty: 1 }], addressId: String(c.address._id) });
    expect(quote.body.data.legs[0].items[0].image).toBe(productPlaceholder("fashion"));
  });

  it("returns no image at all when placeholders are off (the UI then shows its own initial tile)", async () => {
    const v = await createVendor({ name: "Live Store" });
    await createProduct(v.vendor, { slug: "plain" });
    const before = env.PLACEHOLDER_IMAGES;
    try {
      (env as { PLACEHOLDER_IMAGES?: string }).PLACEHOLDER_IMAGES = "false";
      expect((await api().get("/api/products")).body.data[0].image).toBeNull();
      expect((await api().get("/api/products/plain")).body.data.images).toEqual([]);
      expect((await api().get("/api/categories")).body.data[0].image).toBeNull();
    } finally {
      (env as { PLACEHOLDER_IMAGES?: string }).PLACEHOLDER_IMAGES = before;
    }
  });
});

describe("vendors and stand-in photos", () => {
  async function asVendor() {
    const v = await createVendor({ name: "Demo Vendor" });
    const bearer = await loginToken(v.email);
    return { ...v, bearer };
  }

  it("lets a vendor edit a demo product while keeping its stand-in photos", async () => {
    const v = await asVendor();
    const images = [placeholderImage(PHOTO.flourSack), placeholderImage(PHOTO.flourShelf)];
    const p = await createProduct(v.vendor, { images });
    const res = await api().patch(`/api/vendor/products/${p._id}`).set("Authorization", v.bearer).send({ stock: 3, images });
    expect(res.status).toBe(200);
    expect(res.body.data.images.map((i: { publicId: string }) => i.publicId)).toEqual(images.map((i) => i.publicId));
  });

  it("still refuses another store's real uploaded image", async () => {
    const v = await asVendor();
    const p = await createProduct(v.vendor);
    const res = await api().patch(`/api/vendor/products/${p._id}`).set("Authorization", v.bearer).send({ images: [{ url: "https://img.test/x.jpg", publicId: "vendors/someone-else/products/x" }] });
    expect(res.status).toBe(422);
  });

  it("does not ask storage to delete a shared stand-in photo when it is removed or the product is deleted", async () => {
    const v = await asVendor();
    const removeSpy = vi.spyOn(memoryStorage, "remove");
    const images = [placeholderImage(PHOTO.yams)];
    const p = await createProduct(v.vendor, { images });
    await api().patch(`/api/vendor/products/${p._id}`).set("Authorization", v.bearer).send({ images: [] });
    await api().delete(`/api/vendor/products/${p._id}`).set("Authorization", v.bearer);
    expect(removeSpy).not.toHaveBeenCalled();
    removeSpy.mockRestore();
  });
});

describe("demo data seeder", () => {
  it("loads two approved stores, photographed products, a handler and a customer with a saved address", async () => {
    const made = await seedDemoData("Demo12345");
    expect(made).toEqual({ users: 4, vendors: 2, products: DEMO_PRODUCT_COUNT });

    const vendors = await Vendor.find().sort({ businessName: 1 });
    expect(vendors.map((v) => [v.businessName, v.status])).toEqual([["Adire House", "APPROVED"], ["Bodija Provisions", "APPROVED"]]);
    expect(vendors.every((v) => isUnsplash(v.logo))).toBe(true);

    const products = await Product.find();
    expect(products).toHaveLength(DEMO_PRODUCT_COUNT);
    for (const p of products) {
      expect(p.images.length).toBeGreaterThanOrEqual(1);
      expect(p.images.every((i) => i.publicId.startsWith(PLACEHOLDER_PREFIX) && isUnsplash(i.url))).toBe(true);
    }
    expect(await User.countDocuments({ role: "HANDLER" })).toBe(1);
    const customer = (await User.findOne({ email: `customer@${DEMO_EMAIL_DOMAIN}` }))!;
    expect(await Address.countDocuments({ userId: customer._id, isDefault: true })).toBe(1);
  });

  it("makes the demo store visible to shoppers, with images everywhere", async () => {
    await seedDemoData("Demo12345");
    const list = await api().get("/api/products?limit=48");
    expect(list.body.meta.total).toBe(DEMO_PRODUCT_COUNT);
    expect(list.body.data.every((p: { image: string }) => isUnsplash(p.image))).toBe(true);
    const detail = await api().get("/api/products/yam-tuber");
    expect(detail.body.data.images.length).toBe(2);
    const store = await api().get("/api/vendors/adire-house");
    expect(isUnsplash(store.body.data.logo)).toBe(true);
  });

  it("can be run again without duplicating or overwriting anything", async () => {
    await seedDemoData("Demo12345");
    await Product.updateOne({ slug: "yam-tuber" }, { priceKobo: 999900, stock: 1 });
    await Vendor.updateOne({ slug: "adire-house" }, { description: "Edited by the owner" });
    const again = await seedDemoData("Different999");
    expect(again).toEqual({ users: 0, vendors: 0, products: 0 });
    expect(await Product.countDocuments()).toBe(DEMO_PRODUCT_COUNT);
    expect(await User.countDocuments()).toBe(4);
    expect((await Product.findOne({ slug: "yam-tuber" }))!.priceKobo).toBe(999900);
    expect((await Vendor.findOne({ slug: "adire-house" }))!.description).toBe("Edited by the owner");
  });

  it("uses the password it was given, never a hardcoded one", async () => {
    await seedDemoData("Sh4redWithClient");
    const ok = await api().post("/api/auth/login").send({ email: `vendor@${DEMO_EMAIL_DOMAIN}`, password: "Sh4redWithClient" });
    expect(ok.status).toBe(200);
    const bad = await api().post("/api/auth/login").send({ email: `vendor@${DEMO_EMAIL_DOMAIN}`, password: "Passw0rd123" });
    expect(bad.status).toBe(401);
  });

  it("lets the demo customer actually place an order against the demo stores", async () => {
    await seedDemoData("Demo12345");
    const bearer = await loginToken(`customer@${DEMO_EMAIL_DOMAIN}`, "Demo12345");
    const products = (await api().get("/api/products?limit=48")).body.data;
    const addr = (await api().get("/api/me/addresses").set("Authorization", bearer)).body.data[0];
    const sellable = products.filter((p: { inStock: boolean }) => p.inStock).slice(0, 2);
    const res = await api().post("/api/checkout/quote").set("Authorization", bearer).send({ items: sellable.map((p: { id: string }) => ({ productId: p.id, qty: 1 })), addressId: addr.id });
    expect(res.status).toBe(200);
    expect(res.body.data.totalKobo).toBeGreaterThan(0);
  });
});
