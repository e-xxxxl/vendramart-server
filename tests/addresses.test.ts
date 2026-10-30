import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Address } from "../src/models/Address.js";
import { City } from "../src/models/City.js";
import { LAGOS, MID_OCEAN, api, clearDb, createCustomer, createUser, loginToken, seedReferenceData, startDb, stopDb } from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

const body = (over: Record<string, unknown> = {}) => ({ label: "Work", line: "5 Ring Road, Ibadan", lat: 7.3775, lng: 3.947, ...over });
const post = (bearer: string, b: unknown) => api().post("/api/me/addresses").set("Authorization", bearer).send(b as object);
const patch = (bearer: string, id: string, b: unknown) => api().patch(`/api/me/addresses/${id}`).set("Authorization", bearer).send(b as object);
const del = (bearer: string, id: string) => api().delete(`/api/me/addresses/${id}`).set("Authorization", bearer);
const list = (bearer: string) => api().get("/api/me/addresses").set("Authorization", bearer);

describe("address book", () => {
  it("lists the saved address with its city, default first", async () => {
    const c = await createCustomer();
    const res = await list(c.bearer);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ label: "Home", isDefault: true, lat: 7.4, lng: 3.92, city: { name: "Ibadan", isActive: true } });
  });

  it("saves a new address with lat/lng and works out its city", async () => {
    const c = await createCustomer();
    const res = await post(c.bearer, body({ landmark: "next to the bank", placeId: "abc" }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ label: "Work", line: "5 Ring Road, Ibadan", landmark: "next to the bank", placeId: "abc", lat: 7.3775, lng: 3.947, isDefault: false, city: { name: "Ibadan" } });
  });

  it("makes the very first address the default", async () => {
    const user = await createUser("CUSTOMER", "new@example.com");
    const bearer = await loginToken("new@example.com");
    const res = await post(bearer, body());
    expect(res.body.data.isDefault).toBe(true);
    expect(await Address.countDocuments({ userId: user._id, isDefault: true })).toBe(1);
  });

  it("keeps exactly one default when another is promoted", async () => {
    const c = await createCustomer();
    const second = await post(c.bearer, body({ isDefault: true }));
    expect(second.body.data.isDefault).toBe(true);
    const all = (await list(c.bearer)).body.data as { isDefault: boolean; id: string }[];
    expect(all.filter((a) => a.isDefault)).toHaveLength(1);
    expect(all[0]!.id).toBe(second.body.data.id); // default is listed first
  });

  it("updates an address and recomputes the city when the pin moves", async () => {
    const c = await createCustomer();
    const res = await patch(c.bearer, String(c.address._id), { line: "New line, Ibadan", landmark: "by the school" });
    expect(res.body.data).toMatchObject({ line: "New line, Ibadan", landmark: "by the school", city: { name: "Ibadan" } });

    const moved = await patch(c.bearer, String(c.address._id), { lat: LAGOS.lat, lng: LAGOS.lng });
    expect(moved.body.data.city).toMatchObject({ name: "Lagos", isActive: false });

    const nowhere = await patch(c.bearer, String(c.address._id), { lat: MID_OCEAN.lat, lng: MID_OCEAN.lng });
    expect(nowhere.body.data.city).toBeNull();
  });

  it("promotes another address to default when the default is deleted", async () => {
    const c = await createCustomer();
    const other = (await post(c.bearer, body())).body.data;
    const res = await del(c.bearer, String(c.address._id));
    expect(res.body.data.deleted).toBe(true);
    const all = (await list(c.bearer)).body.data;
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: other.id, isDefault: true });
  });

  it("keeps each customer's addresses private (another user's id is a 404)", async () => {
    const a = await createCustomer({ email: "a@example.com" });
    const b = await createCustomer({ email: "b@example.com" });
    expect((await patch(b.bearer, String(a.address._id), { line: "hacked address" })).status).toBe(404);
    expect((await del(b.bearer, String(a.address._id))).status).toBe(404);
    expect((await list(b.bearer)).body.data.map((x: { id: string }) => x.id)).not.toContain(String(a.address._id));
    expect((await Address.findById(a.address._id))!.line).toBe("12 Awolowo Avenue, Old Bodija, Ibadan");
  });

  it("limits the book to 10 addresses", async () => {
    const c = await createCustomer();
    for (let i = 0; i < 9; i++) expect((await post(c.bearer, body({ line: `House ${i}, Ibadan` }))).status).toBe(201);
    const res = await post(c.bearer, body({ line: "One too many, Ibadan" }));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/up to 10/);
  });

  it("validates the address and ignores a client-supplied owner", async () => {
    const c = await createCustomer();
    const bad = await post(c.bearer, { line: "x", lat: 200, lng: 3 });
    expect(bad.status).toBe(422);
    const other = await createUser("CUSTOMER", "victim@example.com");
    const sneaky = await post(c.bearer, body({ userId: String(other._id) }));
    expect(sneaky.status).toBe(201);
    expect(await Address.countDocuments({ userId: other._id })).toBe(0);
  });

  it("rejects unknown fields on update", async () => {
    const c = await createCustomer();
    expect((await patch(c.bearer, String(c.address._id), { userId: "a".repeat(24) })).status).toBe(422);
  });

  it("is for customers only", async () => {
    expect((await api().get("/api/me/addresses")).status).toBe(401);
    await createUser("VENDOR", "v@example.com");
    expect((await list(await loginToken("v@example.com"))).status).toBe(403);
  });

  it("saving an address in a coming-soon city is allowed (checkout refuses it later)", async () => {
    const c = await createCustomer();
    const res = await post(c.bearer, body({ line: "Marina, Lagos", lat: LAGOS.lat, lng: LAGOS.lng }));
    expect(res.status).toBe(201);
    expect(res.body.data.city).toMatchObject({ name: "Lagos", isActive: false });
    expect(await City.countDocuments({ isActive: true })).toBe(1);
  });
});
