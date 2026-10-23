import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { City } from "../src/models/City.js";
import { Product } from "../src/models/Product.js";
import { Settings } from "../src/models/Settings.js";
import { Vendor } from "../src/models/Vendor.js";
import { AppError } from "../src/utils/AppError.js";
import {
  IBADAN, LAGOS, OJA_BA, api, clearDb, createCustomer, createProduct, createUser, createVendor, fakeDistance, loginCookie, quoteReq, seedReferenceData, startDb, stopDb,
} from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  fakeDistance.reset();
});

/** The checkout screen: Bodija Provisions (bean flour N15,000) and Oja'ba Foodstuff (palm oil N15,300). */
async function screenScenario() {
  const bodija = await createVendor({ name: "Bodija Provisions", point: IBADAN });
  const ojaba = await createVendor({ name: "Oja'ba Foodstuff", point: OJA_BA });
  const flour = await createProduct(bodija.vendor, { name: "Omosalewa Bean Flour", priceKobo: 1500000 });
  const oil = await createProduct(ojaba.vendor, { name: "Banga Palm Oil, 4L", priceKobo: 1530000 });
  fakeDistance.setFrom(IBADAN, 3200); // 3.2 km
  fakeDistance.setFrom(OJA_BA, 6400); // 6.4 km
  const customer = await createCustomer();
  const items = [{ productId: String(flour._id), qty: 1 }, { productId: String(oil._id), qty: 1 }];
  return { bodija, ojaba, flour, oil, customer, items };
}

describe("POST /api/checkout/quote", () => {
  it("reproduces the checkout screen to the kobo", async () => {
    const { customer, items } = await screenScenario();
    const res = await quoteReq(customer.cookie, { items, addressId: String(customer.address._id) });
    expect(res.status).toBe(200);
    const q = res.body.data;

    expect(q.legs).toHaveLength(2);
    expect(q.legs[0]).toMatchObject({
      vendor: { businessName: "Bodija Provisions" },
      itemsTotalKobo: 1500000,
      delivery: { distanceKm: "3.2", pricePerKmKobo: 20000, feeKobo: 64000, minFeeApplied: false }, // N640
    });
    expect(q.legs[1]).toMatchObject({
      vendor: { businessName: "Oja'ba Foodstuff" },
      itemsTotalKobo: 1530000,
      delivery: { distanceKm: "6.4", feeKobo: 128000 }, // N1,280
    });
    expect(q.itemsSubtotalKobo).toBe(3030000); // N30,300
    expect(q.deliveryTotalKobo).toBe(192000); // N1,920
    expect(q.totalKobo).toBe(3222000); // N32,220
    expect(q.totalDistanceKm).toBe("9.6");
    expect(q.address).toMatchObject({ label: "Home", city: { name: "Ibadan" } });
  });

  it("asks the distance provider once per vendor, from that vendor's pickup to the drop-off", async () => {
    const { customer, items, bodija } = await screenScenario();
    // Two products from the SAME vendor must not cost a second distance lookup.
    const extra = await createProduct(bodija.vendor, { name: "Garri", priceKobo: 1000000 });
    await quoteReq(customer.cookie, { items: [...items, { productId: String(extra._id), qty: 3 }], addressId: String(customer.address._id) });
    expect(fakeDistance.calls).toHaveLength(2);
    expect(fakeDistance.calls.map((c) => c.origin.lat.toFixed(4)).sort()).toEqual([IBADAN.lat.toFixed(4), OJA_BA.lat.toFixed(4)].sort());
    for (const c of fakeDistance.calls) expect(c.destination).toEqual({ lat: customer.address.location!.lat, lng: customer.address.location!.lng });
  });

  it("makes one leg per vendor, multiplying quantities within it", async () => {
    const { customer, flour, bodija } = await screenScenario();
    const garri = await createProduct(bodija.vendor, { name: "Garri", priceKobo: 1000000 });
    const res = await quoteReq(customer.cookie, {
      items: [{ productId: String(flour._id), qty: 2 }, { productId: String(garri._id), qty: 3 }],
      addressId: String(customer.address._id),
    });
    expect(res.body.data.legs).toHaveLength(1);
    expect(res.body.data.legs[0].itemsTotalKobo).toBe(2 * 1500000 + 3 * 1000000);
    expect(res.body.data.deliveryTotalKobo).toBe(64000); // one delivery, one fee
  });

  it("merges the same product listed twice", async () => {
    const { customer, flour } = await screenScenario();
    const res = await quoteReq(customer.cookie, {
      items: [{ productId: String(flour._id), qty: 1 }, { productId: String(flour._id), qty: 2 }],
      addressId: String(customer.address._id),
    });
    expect(res.body.data.legs[0].items).toHaveLength(1);
    expect(res.body.data.legs[0].items[0].qty).toBe(3);
  });

  describe("never trusts the client for money", () => {
    it("rejects a request that tries to supply its own fee, price, or total", async () => {
      const { customer, items } = await screenScenario();
      const addressId = String(customer.address._id);
      for (const extra of [{ deliveryFeeKobo: 1 }, { totalKobo: 1 }, { distanceMeters: 1 }, { pricePerKmKobo: 1 }]) {
        expect((await quoteReq(customer.cookie, { items, addressId, ...extra })).status, JSON.stringify(extra)).toBe(422);
      }
      const priced = items.map((i) => ({ ...i, priceKobo: 100 }));
      expect((await quoteReq(customer.cookie, { items: priced, addressId })).status).toBe(422);
    });

    it("uses the product's current price from the database", async () => {
      const { customer, items, flour } = await screenScenario();
      await Product.updateOne({ _id: flour._id }, { priceKobo: 1600000 });
      const res = await quoteReq(customer.cookie, { items, addressId: String(customer.address._id) });
      expect(res.body.data.legs[0].itemsTotalKobo).toBe(1600000);
      expect(res.body.data.totalKobo).toBe(1600000 + 1530000 + 192000);
    });

    it("uses the admin's current price per km", async () => {
      const { customer, items } = await screenScenario();
      await Settings.updateOne({ key: "singleton" }, { pricePerKmKobo: 25000 }, { upsert: true }); // N250 per km
      const res = await quoteReq(customer.cookie, { items, addressId: String(customer.address._id) });
      expect(res.body.data.legs.map((l: { delivery: { feeKobo: number } }) => l.delivery.feeKobo)).toEqual([80000, 160000]); // 3.2 and 6.4 km at N250
      expect(res.body.data.pricing.pricePerKmKobo).toBe(25000);
    });

    it("applies the admin's minimum delivery fee to short trips only", async () => {
      const { customer, items } = await screenScenario();
      await Settings.updateOne({ key: "singleton" }, { minDeliveryFeeKobo: 90000 }, { upsert: true }); // N900 minimum
      const res = await quoteReq(customer.cookie, { items, addressId: String(customer.address._id) });
      const [short, long] = res.body.data.legs;
      expect(short.delivery).toMatchObject({ feeKobo: 90000, minFeeApplied: true, minFeeKobo: 90000 }); // N640 raised to N900
      expect(long.delivery).toMatchObject({ feeKobo: 128000, minFeeApplied: false }); // N1,280 untouched
      expect(res.body.data.deliveryTotalKobo).toBe(218000);
    });

    it("falls back to the defaults (N200 per km, no minimum) when no settings exist yet", async () => {
      const { customer, items } = await screenScenario();
      await Settings.deleteMany({}); // seeding creates the defaults; remove them to prove the lazy fallback
      expect(await Settings.countDocuments()).toBe(0);
      const res = await quoteReq(customer.cookie, { items, addressId: String(customer.address._id) });
      expect(res.body.data.pricing).toEqual({ pricePerKmKobo: 20000, minDeliveryFeeKobo: null });
      expect(await Settings.countDocuments()).toBe(1);
    });
  });

  describe("address rules", () => {
    it("refuses someone else's address (404)", async () => {
      const { customer, items } = await screenScenario();
      const other = await createCustomer({ email: "other@example.com" });
      const res = await quoteReq(customer.cookie, { items, addressId: String(other.address._id) });
      expect(res.status).toBe(404);
      expect(fakeDistance.calls).toHaveLength(0);
    });

    it("blocks checkout to an address in a coming-soon city", async () => {
      const { items } = await screenScenario();
      const lagosId = (await City.findOne({ slug: "lagos" }))!._id;
      const c = await createCustomer({ email: "lagos@example.com", point: LAGOS, cityId: lagosId });
      const res = await quoteReq(c.cookie, { items, addressId: String(c.address._id) });
      expect(res.status).toBe(422);
      expect(res.body.error.message).toMatch(/Lagos is coming soon/);
      expect(fakeDistance.calls).toHaveLength(0); // no paid maps call for a blocked city
    });

    it("blocks an address outside every known city", async () => {
      const { items } = await screenScenario();
      const c = await createCustomer({ email: "nowhere@example.com", cityId: null });
      const res = await quoteReq(c.cookie, { items, addressId: String(c.address._id) });
      expect(res.status).toBe(422);
      expect(res.body.error.message).toMatch(/outside the cities we serve/);
    });

    it("blocks a cart whose vendor ships from a different city than the address", async () => {
      const { customer, items, bodija } = await screenScenario();
      const lagos = (await City.findOneAndUpdate({ slug: "lagos" }, { isActive: true }, { returnDocument: "after" }))!;
      await Vendor.updateOne({ _id: bodija.vendor._id }, { "pickup.cityId": lagos._id });
      // Both cities are live now, but the vendor and the address are in different ones.
      const res = await quoteReq(customer.cookie, { items, addressId: String(customer.address._id) });
      expect(res.status).toBe(422);
      expect(res.body.error.message).toMatch(/cannot deliver across cities/);
      expect(res.body.error.message).toMatch(/Bodija Provisions/);
    });
  });

  describe("cart problems", () => {
    it("returns 409 with per-item details when a product is sold out, short, or gone", async () => {
      const { customer, bodija, ojaba, flour, oil } = await screenScenario();
      await Product.updateOne({ _id: flour._id }, { stock: 0 });
      await Product.updateOne({ _id: oil._id }, { stock: 2 });
      const gone = await createProduct(bodija.vendor, { name: "Gone" });
      await gone.deleteOne();

      const res = await quoteReq(customer.cookie, {
        items: [
          { productId: String(flour._id), qty: 1 },
          { productId: String(oil._id), qty: 5 },
          { productId: String(gone._id), qty: 1 },
        ],
        addressId: String(customer.address._id),
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CONFLICT");
      const statuses = res.body.error.details.map((d: { status: string }) => d.status).sort();
      expect(statuses).toEqual(["LOW_STOCK", "OUT_OF_STOCK", "UNAVAILABLE"]);
      expect(res.body.error.details.find((d: { status: string }) => d.status === "LOW_STOCK").maxQty).toBe(2);
      expect(fakeDistance.calls).toHaveLength(0);
      void ojaba;
    });

    it("treats a product from a suspended store as unavailable", async () => {
      const { customer, items, bodija } = await screenScenario();
      await Vendor.updateOne({ _id: bodija.vendor._id }, { status: "SUSPENDED" });
      const res = await quoteReq(customer.cookie, { items, addressId: String(customer.address._id) });
      expect(res.status).toBe(409);
      expect(res.body.error.details[0].status).toBe("UNAVAILABLE");
    });

    it.each([
      ["an empty cart", { items: [] }],
      ["no items field", {}],
      ["51 items", { items: Array.from({ length: 51 }, (_, i) => ({ productId: i.toString(16).padStart(24, "0"), qty: 1 })) }],
      ["a zero quantity", { items: [{ productId: "a".repeat(24), qty: 0 }] }],
      ["a malformed product id", { items: [{ productId: "nope", qty: 1 }] }],
    ])("rejects %s", async (_n, body) => {
      const c = await createCustomer();
      expect((await quoteReq(c.cookie, { ...body, addressId: String(c.address._id) })).status).toBe(422);
    });

    it("rejects a malformed address id", async () => {
      const { customer, items } = await screenScenario();
      expect((await quoteReq(customer.cookie, { items, addressId: "nope" })).status).toBe(422);
    });
  });

  describe("distance provider problems", () => {
    it("returns a 503 the shopper can understand when maps is down, without leaking details", async () => {
      const { customer, items } = await screenScenario();
      fakeDistance.failWith = AppError.unavailable("We could not work out the delivery distance right now. Please try again in a moment.");
      const res = await quoteReq(customer.cookie, { items, addressId: String(customer.address._id) });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      expect(res.body.error.message).toMatch(/could not work out the delivery distance/);
    });

    it("turns an unexpected provider crash into a generic 500, not a partial quote", async () => {
      const { customer, items } = await screenScenario();
      fakeDistance.failWith = new Error("socket hang up with secret-key-123");
      const res = await quoteReq(customer.cookie, { items, addressId: String(customer.address._id) });
      expect(res.status).toBe(500);
      expect(res.body.data).toBeUndefined();
    });
  });

  describe("access", () => {
    it("needs a signed-in customer", async () => {
      const { items, customer } = await screenScenario();
      const body = { items, addressId: String(customer.address._id) };
      expect((await api().post("/api/checkout/quote").set({ "X-Requested-With": "vendramart" }).send(body)).status).toBe(401);
      for (const role of ["VENDOR", "ADMIN", "HANDLER"] as const) {
        await createUser(role, `${role}@example.com`);
        expect((await quoteReq(await loginCookie(`${role}@example.com`), body)).status, role).toBe(403);
      }
    });
  });
});
