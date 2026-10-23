import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { City } from "../src/models/City.js";
import { Vendor } from "../src/models/Vendor.js";
import { api, categoryId, clearDb, createProduct, createVendor, seedReferenceData, startDb, stopDb } from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

const names = (res: { body: { data: { name: string }[] } }) => res.body.data.map((p) => p.name).sort();

describe("storefront visibility", () => {
  it("shows an approved vendor's active products and hides everyone else's", async () => {
    const live = await createVendor({ name: "Live Store", status: "APPROVED" });
    const pending = await createVendor({ name: "Pending Store", status: "PENDING" });
    const suspended = await createVendor({ name: "Suspended Store", status: "SUSPENDED" });
    await createProduct(live.vendor, { name: "Visible Rice" });
    await createProduct(live.vendor, { name: "Hidden Draft", isActive: false });
    await createProduct(pending.vendor, { name: "Pending Beans" });
    await createProduct(suspended.vendor, { name: "Suspended Yam" });

    expect(names(await api().get("/api/products"))).toEqual(["Visible Rice"]);
  });

  it("returns 404 for the product page of an unapproved, suspended or inactive product", async () => {
    const pending = await createVendor({ status: "PENDING" });
    const p = await createProduct(pending.vendor, { slug: "pending-thing" });
    expect((await api().get("/api/products/pending-thing")).status).toBe(404);

    await Vendor.updateOne({ _id: pending.vendor._id }, { status: "APPROVED" });
    expect((await api().get("/api/products/pending-thing")).status).toBe(200);

    await Vendor.updateOne({ _id: pending.vendor._id }, { status: "SUSPENDED" });
    expect((await api().get("/api/products/pending-thing")).status).toBe(404);

    await Vendor.updateOne({ _id: pending.vendor._id }, { status: "APPROVED" });
    p.isActive = false;
    await p.save();
    expect((await api().get("/api/products/pending-thing")).status).toBe(404);
  });

  it("hides stores and products in a coming-soon city", async () => {
    const v = await createVendor({ name: "Live Store" });
    await createProduct(v.vendor, { name: "Rice" });
    await City.updateOne({ slug: "ibadan" }, { isActive: false });
    expect((await api().get("/api/products")).body.data).toEqual([]);
    expect((await api().get("/api/vendors")).body.data).toEqual([]);
    expect((await api().get("/api/vendors/" + v.vendor.slug)).status).toBe(404);
  });

  it("hides unapproved stores from the vendor list and store page", async () => {
    const live = await createVendor({ name: "Live Store" });
    const pending = await createVendor({ name: "Pending Store", status: "PENDING" });
    const list = await api().get("/api/vendors");
    expect(list.body.data.map((v: { businessName: string }) => v.businessName)).toEqual(["Live Store"]);
    expect((await api().get(`/api/vendors/${live.vendor.slug}`)).status).toBe(200);
    expect((await api().get(`/api/vendors/${pending.vendor.slug}`)).status).toBe(404);
  });

  it("never leaks private vendor fields (bank, CAC, phone, email) on public endpoints", async () => {
    const v = await createVendor({ name: "Live Store" });
    await Vendor.updateOne({ _id: v.vendor._id }, { cacNumber: "RC-SECRET-1" });
    const p = await createProduct(v.vendor, { slug: "rice" });
    const bodies = [
      await api().get("/api/vendors"),
      await api().get(`/api/vendors/${v.vendor.slug}`),
      await api().get("/api/products"),
      await api().get(`/api/products/${p.slug}`),
      await api().get("/api/home"),
    ].map((r) => JSON.stringify(r.body));
    for (const body of bodies) {
      for (const secret of ["0123456789", "RC-SECRET-1", "08031234567", v.email, "accountNumber", "passwordHash"]) {
        expect(body, secret).not.toContain(secret);
      }
    }
  });
});

describe("search and filters", () => {
  async function seedCatalog() {
    const bodija = await createVendor({ name: "Bodija Provisions" });
    const adire = await createVendor({ name: "Adire House" });
    const fashion = await categoryId("fashion");
    await createProduct(bodija.vendor, { name: "Omosalewa Bean Flour", priceKobo: 1500000, soldCount: 5 });
    await createProduct(bodija.vendor, { name: "Garri Ijebu", priceKobo: 1200000, soldCount: 9 });
    await createProduct(adire.vendor, { name: "Tie-Dye T-Shirt", categoryId: fashion, priceKobo: 1200000, soldCount: 1 });
    return { bodija, adire };
  }

  it("filters by category slug", async () => {
    await seedCatalog();
    expect(names(await api().get("/api/products?category=fashion"))).toEqual(["Tie-Dye T-Shirt"]);
    expect(names(await api().get("/api/products?category=grains-and-flour"))).toEqual(["Garri Ijebu", "Omosalewa Bean Flour"]);
    expect((await api().get("/api/products?category=nonsense")).body.data).toEqual([]);
  });

  it("filters by vendor slug", async () => {
    const { adire } = await seedCatalog();
    expect(names(await api().get(`/api/products?vendor=${adire.vendor.slug}`))).toEqual(["Tie-Dye T-Shirt"]);
  });

  it("filters by city: Ibadan has products, a coming-soon city has none", async () => {
    await seedCatalog();
    expect((await api().get("/api/products?city=ibadan")).body.meta.total).toBe(3);
    expect((await api().get("/api/products?city=lagos")).body.data).toEqual([]);
    expect((await api().get("/api/products?city=atlantis")).body.data).toEqual([]);
  });

  it("searches product names, store names and category names, case-insensitively", async () => {
    await seedCatalog();
    expect(names(await api().get("/api/products?q=BEAN"))).toEqual(["Omosalewa Bean Flour"]);
    expect(names(await api().get("/api/products?q=adire"))).toEqual(["Tie-Dye T-Shirt"]); // store name
    expect(names(await api().get("/api/products?q=fashion"))).toEqual(["Tie-Dye T-Shirt"]); // category name
  });

  it("treats regex characters in a search as plain text", async () => {
    await seedCatalog();
    const res = await api().get("/api/products?q=" + encodeURIComponent(".*"));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect((await api().get("/api/products?q=" + encodeURIComponent("("))).status).toBe(200);
  });

  it("sorts by price and by popularity", async () => {
    await seedCatalog();
    const asc = await api().get("/api/products?sort=price_asc");
    expect(asc.body.data[0].priceKobo).toBe(1200000);
    expect(asc.body.data.at(-1).priceKobo).toBe(1500000);
    const desc = await api().get("/api/products?sort=price_desc");
    expect(desc.body.data[0].name).toBe("Omosalewa Bean Flour");
    const popular = await api().get("/api/products?sort=popular");
    expect(popular.body.data.map((p: { name: string }) => p.name)).toEqual(["Garri Ijebu", "Omosalewa Bean Flour", "Tie-Dye T-Shirt"]);
  });

  it("paginates and reports totals", async () => {
    await seedCatalog();
    const p1 = await api().get("/api/products?limit=2&page=1");
    const p2 = await api().get("/api/products?limit=2&page=2");
    expect(p1.body.meta).toEqual({ page: 1, limit: 2, total: 3 });
    expect(p1.body.data).toHaveLength(2);
    expect(p2.body.data).toHaveLength(1);
  });

  it("rejects an invalid sort or an oversized page", async () => {
    expect((await api().get("/api/products?sort=cheapest")).status).toBe(422);
    expect((await api().get("/api/products?limit=500")).status).toBe(422);
  });

  it("marks out-of-stock items without hiding them", async () => {
    const v = await createVendor();
    await createProduct(v.vendor, { name: "Sold Out", stock: 0 });
    const res = await api().get("/api/products");
    expect(res.body.data[0]).toMatchObject({ name: "Sold Out", inStock: false, stock: 0 });
  });
});

describe("home and product detail", () => {
  it("returns categories, best sellers (by sales) and new arrivals", async () => {
    const v = await createVendor();
    await createProduct(v.vendor, { name: "Old Hit", soldCount: 50, createdAt: new Date("2026-01-01") });
    await createProduct(v.vendor, { name: "Brand New", soldCount: 0 });
    const res = await api().get("/api/home?city=ibadan");
    expect(res.body.data.categories).toHaveLength(7);
    expect(res.body.data.bestSellers[0].name).toBe("Old Hit");
    expect(res.body.data.newArrivals[0].name).toBe("Brand New");
  });

  it("returns a product row for a featured category only once it has enough products, and store tiles with photos", async () => {
    const v = await createVendor({ name: "Ade Fabrics" });
    const fashion = await categoryId("fashion");
    for (let i = 1; i <= 2; i++) await createProduct(v.vendor, { name: `Cloth ${i}`, categoryId: fashion });

    const thin = await api().get("/api/home?city=ibadan");
    expect(thin.body.data.categoryRows).toEqual([]);

    await createProduct(v.vendor, { name: "Cloth 3", categoryId: fashion });
    const full = await api().get("/api/home?city=ibadan");
    expect(full.body.data.categoryRows).toHaveLength(1);
    expect(full.body.data.categoryRows[0]).toMatchObject({ category: { slug: "fashion", name: "Fashion" } });
    expect(full.body.data.categoryRows[0].products).toHaveLength(3);

    expect(full.body.data.stores).toHaveLength(1);
    expect(full.body.data.stores[0]).toMatchObject({ businessName: "Ade Fabrics", slug: v.vendor.slug });
    expect(full.body.data.stores[0].photos.length).toBeGreaterThan(0);
    for (const secret of ["0123456789", "accountNumber", v.email]) expect(JSON.stringify(full.body), secret).not.toContain(secret);
  });

  it("leaves unapproved stores out of the store tiles", async () => {
    const live = await createVendor({ name: "Live Store" });
    const pending = await createVendor({ name: "Pending Store", status: "PENDING" });
    await createProduct(live.vendor);
    await createProduct(pending.vendor);
    const res = await api().get("/api/home?city=ibadan");
    expect(res.body.data.stores.map((s: { businessName: string }) => s.businessName)).toEqual(["Live Store"]);
  });

  it("returns an empty home for a coming-soon city", async () => {
    const v = await createVendor();
    await createProduct(v.vendor);
    const res = await api().get("/api/home?city=lagos");
    expect(res.body.data.bestSellers).toEqual([]);
    expect(res.body.data.newArrivals).toEqual([]);
    expect(res.body.data.categories).toHaveLength(7);
  });

  it("returns the full product detail with images, description and store info", async () => {
    const v = await createVendor({ name: "Bodija Provisions" });
    const p = await createProduct(v.vendor, {
      slug: "bean-flour",
      description: "Smooth beans flour",
      images: [{ url: "https://img.test/a.jpg", publicId: "a" }],
    });
    const res = await api().get(`/api/products/${p.slug}`);
    expect(res.body.data).toMatchObject({
      name: "Omosalewa Bean Flour",
      description: "Smooth beans flour",
      priceKobo: 1500000,
      images: ["https://img.test/a.jpg"],
      category: { slug: "grains-and-flour" },
      vendorDetail: { businessName: "Bodija Provisions" },
    });
  });
});
