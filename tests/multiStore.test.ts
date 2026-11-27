import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { User } from "../src/models/User.js";
import { Vendor } from "../src/models/Vendor.js";
import { migrateVendorIndexes } from "../src/models/vendorIndexes.js";
import { api, clearDb, createProduct, createVendor, loginToken, seedReferenceData, startDb, stopDb, vendorBody } from "./helpers.js";
import { asUser, createAdmin, emailLog } from "./fulfilmentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  emailLog.reset();
});

const NIN = "12345678901";

/** What the "add a store" form sends: the store, not the person. */
const storeBody = (name: string, over: Record<string, unknown> = {}) => {
  const b = vendorBody();
  return { businessName: name, pickup: b.pickup, bank: { ...b.bank, accountName: name }, ...over };
};

/** A request as one owner, optionally working on one of their stores. */
const asStore = (bearer: string, storeId?: string) => {
  const r = (method: "get" | "post" | "patch", path: string, body?: object) => {
    const req = api()[method](`/api${path}`).set("Authorization", bearer);
    if (storeId) req.set("X-Store-Id", storeId);
    return body ? req.send(body) : req;
  };
  return { get: (p: string) => r("get", p), post: (p: string, b: object = {}) => r("post", p, b), patch: (p: string, b: object) => r("patch", p, b) };
};

async function owner() {
  const res = await api().post("/api/auth/vendor/register").send(vendorBody({ email: "owner@example.com", nin: NIN, businessName: "First Store" }));
  expect(res.status).toBe(201);
  const first = (await Vendor.findOne({ email: "owner@example.com" }))!;
  return { bearer: await loginToken("owner@example.com"), first, user: (await User.findOne({ email: "owner@example.com" }))! };
}

describe("one owner, up to three stores", () => {
  it("lets an owner add a second and third store on the same sign-in, and refuses a fourth", async () => {
    const o = await owner();
    const me = asStore(o.bearer);

    const second = await me.post("/vendor/stores", storeBody("Second Store"));
    expect(second.status).toBe(201);
    expect(second.body.data).toMatchObject({ businessName: "Second Store", status: "PENDING" });
    expect((await me.post("/vendor/stores", storeBody("Third Store"))).status).toBe(201);

    const fourth = await me.post("/vendor/stores", storeBody("Fourth Store"));
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.message).toMatch(/up to 3 stores/);

    const list = (await me.get("/vendor/stores")).body.data;
    expect(list).toMatchObject({ max: 3, canAdd: false });
    expect(list.stores.map((s: { businessName: string }) => s.businessName)).toEqual(["First Store", "Second Store", "Third Store"]);
    expect(await Vendor.countDocuments({ userId: o.user._id })).toBe(3);
    expect(await User.countDocuments({ email: "owner@example.com" })).toBe(1); // still one sign-in
  });

  it("uses the owner's own name and email, and the NIN of their first store when none is given", async () => {
    const o = await owner();
    const made = await asStore(o.bearer).post("/vendor/stores", storeBody("Second Store"));
    const store = (await Vendor.findById(made.body.data.id))!;
    expect(store).toMatchObject({ email: "owner@example.com", ownerName: o.first.ownerName, nin: NIN, status: "PENDING" });
    expect(store.slug).not.toBe(o.first.slug);
  });

  it("counts a NIN across stores: it backs at most three", async () => {
    const o = await owner(); // 1 on this NIN
    await asStore(o.bearer).post("/vendor/stores", storeBody("Second Store")); // 2
    const other = await api().post("/api/auth/vendor/register").send(vendorBody({ email: "other@example.com", nin: NIN, businessName: "Other Owner Store" })); // 3
    expect(other.status).toBe(201);

    const blocked = await asStore(o.bearer).post("/vendor/stores", storeBody("Third Store")); // would be 4
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/already used for 3 stores/);
    expect(await Vendor.countDocuments({ userId: o.user._id })).toBe(2);
  });

  it("is for store owners only, and validates the store", async () => {
    const o = await owner();
    expect((await asStore(o.bearer).post("/vendor/stores", { businessName: "x" })).status).toBe(422);
    expect((await asStore(o.bearer).post("/vendor/stores", { ...storeBody("Second"), userId: "nope" })).status).toBe(422);
    expect((await api().post("/api/vendor/stores").send(storeBody("Second"))).status).toBe(401);
  });

  it("lets two people add at the same moment without ending up with a fourth", async () => {
    const o = await owner();
    await asStore(o.bearer).post("/vendor/stores", storeBody("Second Store"));
    const results = await Promise.all([1, 2, 3].map((n) => asStore(o.bearer).post("/vendor/stores", storeBody(`Racer ${n}`))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await Vendor.countDocuments({ userId: o.user._id })).toBe(3);
  });
});

describe("working on one store at a time", () => {
  it("shows the store named in X-Store-Id, and the first store with no header", async () => {
    const o = await owner();
    const second = (await asStore(o.bearer).post("/vendor/stores", storeBody("Second Store"))).body.data.id as string;
    await createProduct(o.first, {});
    expect((await asStore(o.bearer).get("/vendor/overview")).body.data).toMatchObject({ vendor: { businessName: "First Store" }, counts: { products: 1 } });
    expect((await asStore(o.bearer, second).get("/vendor/overview")).body.data).toMatchObject({ vendor: { businessName: "Second Store" }, counts: { products: 0 } });

    // Changes go to the store that is open, not to the other one.
    await asStore(o.bearer, second).patch("/vendor/profile", { description: "Only the second" });
    expect((await Vendor.findById(second))!.description).toBe("Only the second");
    expect((await Vendor.findById(o.first._id))!.description).not.toBe("Only the second");
  });

  it("never opens another owner's store, or one that does not exist", async () => {
    const o = await owner();
    const stranger = await createVendor({ email: "stranger@example.com", name: "Stranger Store" });
    for (const id of [String(stranger.vendor._id), "000000000000000000000000", "not-an-id"]) {
      const res = await asStore(o.bearer, id).get("/vendor/overview");
      expect(res.status, id).toBe(404);
    }
    expect((await asStore(o.bearer, String(stranger.vendor._id)).patch("/vendor/profile", { description: "taken over" })).status).toBe(404);
    expect((await Vendor.findById(stranger.vendor._id))!.description).not.toBe("taken over");
  });
});

describe("the admin and one owner's stores", () => {
  it("adds a store to an existing owner instead of making a second account, up to three", async () => {
    const o = await owner();
    const admin = await createAdmin();
    const body = (name: string) => {
      const { password: _p, ...rest } = vendorBody({ email: "owner@example.com", nin: NIN, businessName: name });
      return rest;
    };
    emailLog.reset();
    const res = await asUser(admin.bearer).post("/admin/vendors", body("Admin Added"));
    expect(res.status).toBe(201);
    expect(await User.countDocuments({ email: "owner@example.com" })).toBe(1);
    expect(await Vendor.countDocuments({ userId: o.user._id })).toBe(2);
    expect(emailLog.sent).toHaveLength(0); // no invite: they already have a sign-in

    expect((await asUser(admin.bearer).post("/admin/vendors", body("Admin Added Two"))).status).toBe(201);
    expect((await asUser(admin.bearer).post("/admin/vendors", body("Admin Added Three"))).status).toBe(409);
  });

  it("keeps the owner's sign-in when one of their stores is deleted, and removes it with the last one", async () => {
    const o = await owner();
    const second = (await asStore(o.bearer).post("/vendor/stores", storeBody("Second Store"))).body.data.id as string;
    const admin = await createAdmin();

    expect((await asUser(admin.bearer).delete(`/admin/vendors/${second}`)).status).toBe(200);
    expect(await Vendor.countDocuments({ userId: o.user._id })).toBe(1);
    expect(await User.exists({ _id: o.user._id })).toBeTruthy();
    expect((await asStore(o.bearer).get("/vendor/overview")).status).toBe(200);

    expect((await asUser(admin.bearer).delete(`/admin/vendors/${o.first._id}`)).status).toBe(200);
    expect(await User.exists({ _id: o.user._id })).toBeNull();
  });
});

describe("databases made before several stores were allowed", () => {
  it("drops the old one-store-only indexes so a second store can be saved", async () => {
    const o = await owner();
    // The way an older database has them.
    await Vendor.collection.dropIndex("userId_1").catch(() => {});
    await Vendor.collection.dropIndex("nin_1").catch(() => {});
    await Vendor.collection.createIndex({ userId: 1 }, { unique: true });
    await Vendor.collection.createIndex({ nin: 1 }, { unique: true, sparse: true });
    expect((await asStore(o.bearer).post("/vendor/stores", storeBody("Second Store"))).status).not.toBe(201); // the old index refuses it

    const dropped = await migrateVendorIndexes();
    expect(dropped.sort()).toEqual(["nin_1", "userId_1"]);
    expect((await asStore(o.bearer).post("/vendor/stores", storeBody("Second Store"))).status).toBe(201);

    // Running it again changes nothing.
    expect(await migrateVendorIndexes()).toEqual([]);
    const indexes = await Vendor.collection.indexes();
    expect(indexes.find((i) => i.name === "userId_1")?.unique).toBeFalsy();
    expect(indexes.find((i) => i.name === "nin_1")?.unique).toBeFalsy();
  });
});
