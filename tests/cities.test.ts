import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { City } from "../src/models/City.js";
import { Category } from "../src/models/Category.js";
import { api, clearDb, seedReferenceData, startDb, stopDb } from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

describe("cities and categories", () => {
  it("lists Ibadan as active and the four other cities as coming soon, in order", async () => {
    const res = await api().get("/api/cities");
    expect(res.status).toBe(200);
    const cities = res.body.data as { name: string; isActive: boolean }[];
    expect(cities.map((c) => c.name)).toEqual(["Ibadan", "Lagos", "Port Harcourt", "Benin", "Abuja"]);
    expect(cities.filter((c) => c.isActive).map((c) => c.name)).toEqual(["Ibadan"]);
  });

  it("does not expose coordinates or internals on the public list", async () => {
    const res = await api().get("/api/cities");
    expect(Object.keys(res.body.data[0]).sort()).toEqual(["id", "isActive", "name", "slug"]);
  });

  it("lists the seven storefront categories", async () => {
    const res = await api().get("/api/categories");
    expect(res.body.data.map((c: { slug: string }) => c.slug)).toEqual([
      "grains-and-flour",
      "oils-and-condiments",
      "tubers-and-produce",
      "beans-and-legumes",
      "fashion",
      "beauty-and-fragrance",
      "accessories",
    ]);
  });

  it("seeding twice creates no duplicates and never switches a city the admin enabled back off", async () => {
    await City.updateOne({ slug: "lagos" }, { isActive: true });
    await City.updateOne({ slug: "ibadan" }, { isActive: false });
    await seedReferenceData();
    expect(await City.countDocuments()).toBe(5);
    expect(await Category.countDocuments()).toBe(7);
    expect((await City.findOne({ slug: "lagos" }))!.isActive).toBe(true);
    expect((await City.findOne({ slug: "ibadan" }))!.isActive).toBe(false);
  });
});
