import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Product } from "../src/models/Product.js";
import { Vendor } from "../src/models/Vendor.js";
import { api, clearDb, createProduct, createVendor, seedReferenceData, startDb, stopDb } from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

const validate = (items: unknown) => api().post("/api/cart/validate").send({ items });

describe("POST /api/cart/validate", () => {
  it("is public and returns the current name, price, vendor and stock", async () => {
    const v = await createVendor({ name: "Bodija Provisions" });
    const p = await createProduct(v.vendor, { name: "Omosalewa Bean Flour", priceKobo: 1500000, stock: 10 });
    const res = await validate([{ productId: String(p._id), qty: 2 }]);
    expect(res.status).toBe(200);
    expect(res.body.data.lines[0]).toMatchObject({
      productId: String(p._id),
      qty: 2,
      status: "OK",
      maxQty: 10,
      name: "Omosalewa Bean Flour",
      priceKobo: 1500000,
      vendor: { businessName: "Bodija Provisions" },
    });
  });

  it("uses the database price, so a price change is picked up and a client price is refused", async () => {
    const v = await createVendor();
    const p = await createProduct(v.vendor, { priceKobo: 1500000 });
    await Product.updateOne({ _id: p._id }, { priceKobo: 1700000 });
    expect((await validate([{ productId: String(p._id), qty: 1 }])).body.data.lines[0].priceKobo).toBe(1700000);
    expect((await validate([{ productId: String(p._id), qty: 1, priceKobo: 1 }])).status).toBe(422);
  });

  it("flags low stock with the most the shopper can buy", async () => {
    const v = await createVendor();
    const p = await createProduct(v.vendor, { stock: 3 });
    const line = (await validate([{ productId: String(p._id), qty: 5 }])).body.data.lines[0];
    expect(line).toMatchObject({ status: "LOW_STOCK", maxQty: 3, qty: 5 });
  });

  it("flags sold-out items", async () => {
    const v = await createVendor();
    const p = await createProduct(v.vendor, { stock: 0 });
    expect((await validate([{ productId: String(p._id), qty: 1 }])).body.data.lines[0]).toMatchObject({ status: "OUT_OF_STOCK", maxQty: 0 });
  });

  it("marks hidden, unapproved, suspended, deleted and unknown products UNAVAILABLE without revealing them", async () => {
    const live = await createVendor({ name: "Live" });
    const pending = await createVendor({ name: "Pending", status: "PENDING" });
    const suspended = await createVendor({ name: "Suspended", status: "SUSPENDED" });
    const hidden = await createProduct(live.vendor, { name: "Secret Draft", isActive: false });
    const unapproved = await createProduct(pending.vendor, { name: "Unapproved Item" });
    const banned = await createProduct(suspended.vendor, { name: "Banned Item" });
    const gone = await createProduct(live.vendor, { name: "Deleted Item" });
    await gone.deleteOne();

    const ids = [hidden, unapproved, banned, gone].map((p) => String(p._id));
    const res = await validate([...ids, "a".repeat(24)].map((productId) => ({ productId, qty: 1 })));
    for (const line of res.body.data.lines) {
      expect(line).toMatchObject({ status: "UNAVAILABLE", maxQty: 0 });
      expect(line.name).toBeUndefined();
      expect(line.priceKobo).toBeUndefined();
    }
    const text = JSON.stringify(res.body);
    for (const secret of ["Secret Draft", "Unapproved Item", "Banned Item", "Deleted Item"]) expect(text).not.toContain(secret);
  });

  it("notices when a store is suspended after the item was added to the cart", async () => {
    const v = await createVendor();
    const p = await createProduct(v.vendor);
    expect((await validate([{ productId: String(p._id), qty: 1 }])).body.data.lines[0].status).toBe("OK");
    await Vendor.updateOne({ _id: v.vendor._id }, { status: "SUSPENDED" });
    expect((await validate([{ productId: String(p._id), qty: 1 }])).body.data.lines[0].status).toBe("UNAVAILABLE");
  });

  it("merges repeated products, keeps order, and caps a line at 99", async () => {
    const v = await createVendor();
    const a = await createProduct(v.vendor, { name: "A", stock: 500 });
    const b = await createProduct(v.vendor, { name: "B", stock: 500 });
    const res = await validate([
      { productId: String(a._id), qty: 60 },
      { productId: String(b._id), qty: 1 },
      { productId: String(a._id), qty: 60 },
    ]);
    expect(res.body.data.lines.map((l: { name: string; qty: number }) => [l.name, l.qty])).toEqual([["A", 99], ["B", 1]]);
  });

  it("returns an empty list for an empty cart", async () => {
    expect((await validate([])).body.data.lines).toEqual([]);
  });

  it.each([
    ["zero quantity", [{ productId: "a".repeat(24), qty: 0 }]],
    ["negative quantity", [{ productId: "a".repeat(24), qty: -2 }]],
    ["fractional quantity", [{ productId: "a".repeat(24), qty: 1.5 }]],
    ["quantity over 99", [{ productId: "a".repeat(24), qty: 100 }]],
    ["malformed product id", [{ productId: "nope", qty: 1 }]],
    ["operator-looking product id", [{ productId: { $ne: null }, qty: 1 }]],
  ])("rejects %s", async (_n, items) => {
    expect((await validate(items)).status).toBe(422);
  });

  it("rejects more than 50 different items", async () => {
    const items = Array.from({ length: 51 }, (_, i) => ({ productId: i.toString(16).padStart(24, "0"), qty: 1 }));
    expect((await validate(items)).status).toBe(422);
  });
});
