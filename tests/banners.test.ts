import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Banner, bannerState } from "../src/models/Banner.js";
import { seedDemoData } from "../src/seed/demo.js";
import { api, clearDb, createUser, loginToken, pngBytes, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin } from "./fulfilmentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

const good = (over: Record<string, unknown> = {}) => ({
  placement: "HERO",
  title: "Weekend market sale",
  subtitle: "Fresh produce at lower prices",
  ctaLabel: "Shop now",
  link: "/category/?slug=tubers-and-produce",
  image: "https://img.test/banners/1.jpg",
  ...over,
});
const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

describe("who can manage banners", () => {
  it("is for the admin only: customers, vendors, handlers and visitors are refused", async () => {
    expect((await api().get("/api/admin/banners")).status).toBe(401);
    for (const role of ["CUSTOMER", "VENDOR", "HANDLER"] as const) {
      await createUser(role, `${role.toLowerCase()}@example.com`);
      const bearer = await loginToken(`${role.toLowerCase()}@example.com`);
      expect((await asUser(bearer).get("/admin/banners")).status).toBe(403);
      expect((await asUser(bearer).post("/admin/banners", good())).status).toBe(403);
    }
    expect(await Banner.countDocuments()).toBe(0);
  });
});

describe("adding and changing banners", () => {
  it("creates a banner at the end of its group and lists it", async () => {
    const a = asUser((await createAdmin()).bearer);
    const one = await a.post("/admin/banners", good({ title: "First" }));
    const two = await a.post("/admin/banners", good({ title: "Second" }));
    const side = await a.post("/admin/banners", good({ title: "Side", placement: "SIDE" }));
    expect(one.status).toBe(201);
    expect([one.body.data.sortOrder, two.body.data.sortOrder, side.body.data.sortOrder]).toEqual([0, 1, 0]);
    expect(one.body.data.state).toBe("LIVE");
    const list = await a.get("/admin/banners");
    expect(list.body.data.map((b: { title: string }) => b.title)).toEqual(["First", "Second", "Side"]);
  });

  it("refuses links that could run code or leave for a lookalike address", async () => {
    const a = asUser((await createAdmin()).bearer);
    for (const link of ["javascript:alert(1)", "data:text/html,hi", "//evil.example/x", "http://plain.example", "category/fashion", "/ok\\evil", ""]) {
      const res = await a.post("/admin/banners", good({ link }));
      expect(res.status, link).toBe(422);
    }
    expect((await a.post("/admin/banners", good({ link: "https://example.com/sale" }))).status).toBe(201);
    expect((await a.post("/admin/banners", good({ link: "/search/?q=yam" }))).status).toBe(201);
  });

  it("needs a title and a picture, and keeps the words short", async () => {
    const a = asUser((await createAdmin()).bearer);
    expect((await a.post("/admin/banners", good({ title: "  " }))).status).toBe(422);
    expect((await a.post("/admin/banners", good({ title: "x".repeat(81) }))).status).toBe(422);
    expect((await a.post("/admin/banners", good({ ctaLabel: "x".repeat(25) }))).status).toBe(422);
    expect((await a.post("/admin/banners", good({ image: "javascript:alert(1)" }))).status).toBe(422);
    expect((await a.post("/admin/banners", good({ image: "" }))).status).toBe(422);
    expect((await a.post("/admin/banners", good({ placement: "FOOTER" }))).status).toBe(422);
    expect((await a.post("/admin/banners", { ...good(), sortOrder: 5, extra: true })).status).toBe(422);
  });

  it("refuses an end that is not after the start", async () => {
    const a = asUser((await createAdmin()).bearer);
    const res = await a.post("/admin/banners", good({ startsAt: hours(10), endsAt: hours(5) }));
    expect(res.status).toBe(422);
    expect(res.body.error.details?.endsAt ?? JSON.stringify(res.body)).toBeTruthy();
    expect((await a.post("/admin/banners", good({ startsAt: "not a date" }))).status).toBe(422);
  });

  it("edits a banner, switches it off and on, and deletes it", async () => {
    const a = asUser((await createAdmin()).bearer);
    const { id } = (await a.post("/admin/banners", good())).body.data;

    const edited = await a.put(`/admin/banners/${id}`, good({ title: "Changed", subtitle: "", ctaLabel: "" }));
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ title: "Changed", subtitle: null, ctaLabel: null });

    expect((await a.patch(`/admin/banners/${id}`, { isActive: false })).body.data.state).toBe("HIDDEN");
    expect((await a.patch(`/admin/banners/${id}`, { isActive: true })).body.data.state).toBe("LIVE");

    expect((await a.delete(`/admin/banners/${id}`)).status).toBe(200);
    expect(await Banner.countDocuments()).toBe(0);
    expect((await a.delete(`/admin/banners/${id}`)).status).toBe(404);
    expect((await a.put(`/admin/banners/${id}`, good())).status).toBe(404);
  });

  it("reorders a group with the ids in the order they should appear", async () => {
    const a = asUser((await createAdmin()).bearer);
    const ids: string[] = [];
    for (const t of ["A", "B", "C"]) ids.push((await a.post("/admin/banners", good({ title: t }))).body.data.id);
    const res = await a.put("/admin/banners/order", { ids: [ids[2], ids[0], ids[1]] });
    expect(res.status).toBe(200);
    expect(res.body.data.map((b: { title: string }) => b.title)).toEqual(["C", "A", "B"]);
    expect((await a.put("/admin/banners/order", { ids: [ids[0], ids[0]] })).status).toBe(422);
    expect((await a.put("/admin/banners/order", { ids: ["507f1f77bcf86cd799439011"] })).status).toBe(404);
  });
});

describe("uploading a banner picture", () => {
  it("accepts a real image and refuses anything else", async () => {
    const bearer = (await createAdmin()).bearer;
    const ok = await api().post("/api/admin/banners/image").set("Authorization", bearer).attach("file", pngBytes(), { filename: "sale.png", contentType: "image/png" });
    expect(ok.status).toBe(201);
    expect(ok.body.data.url).toContain("banners/");

    const fake = await api().post("/api/admin/banners/image").set("Authorization", bearer).attach("file", Buffer.from("<script>alert(1)</script>"), { filename: "x.png", contentType: "image/png" });
    expect(fake.status).toBe(422);
    const none = await api().post("/api/admin/banners/image").set("Authorization", bearer);
    expect(none.status).toBe(422);
  });

  it("is refused for a vendor", async () => {
    await createUser("VENDOR", "v@example.com");
    const bearer = await loginToken("v@example.com");
    const res = await api().post("/api/admin/banners/image").set("Authorization", bearer).attach("file", pngBytes(), { filename: "a.png", contentType: "image/png" });
    expect(res.status).toBe(403);
  });
});

describe("what shoppers see", () => {
  it("is open to everyone and shows only banners that are live, in order, without admin details", async () => {
    const a = asUser((await createAdmin()).bearer);
    await a.post("/admin/banners", good({ title: "Live one" }));
    await a.post("/admin/banners", good({ title: "Live two" }));
    await a.post("/admin/banners", good({ title: "Hidden", isActive: false }));
    await a.post("/admin/banners", good({ title: "Not yet", startsAt: hours(2) }));
    await a.post("/admin/banners", good({ title: "Started", startsAt: hours(-2), endsAt: hours(2) }));
    const past = await Banner.create({ ...good({ title: "Over" }), placement: "HERO" as const, endsAt: new Date(Date.now() - 1000), startsAt: new Date(Date.now() - 5000) });

    const res = await api().get("/api/banners");
    expect(res.status).toBe(200);
    expect(res.body.data.map((b: { title: string }) => b.title)).toEqual(["Live one", "Live two", "Started"]);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(["ctaLabel", "id", "image", "link", "placement", "subtitle", "title"]);
    expect((await a.get("/admin/banners")).body.data.find((b: { id: string }) => b.id === String(past._id)).state).toBe("ENDED");
  });

  it("works out the state from timestamps alone", () => {
    const now = new Date("2026-01-10T12:00:00Z");
    expect(bannerState({ isActive: true }, now)).toBe("LIVE");
    expect(bannerState({ isActive: false }, now)).toBe("HIDDEN");
    expect(bannerState({ isActive: true, startsAt: new Date("2026-01-11T00:00:00Z") }, now)).toBe("SCHEDULED");
    expect(bannerState({ isActive: true, endsAt: new Date("2026-01-10T12:00:00Z") }, now)).toBe("ENDED");
    expect(bannerState({ isActive: true, startsAt: new Date("2026-01-01T00:00:00Z"), endsAt: new Date("2026-02-01T00:00:00Z") }, now)).toBe("LIVE");
  });
});

describe("demo banners", () => {
  it("are added once to an empty shop and never touch what an admin has set up", async () => {
    await seedDemoData("Passw0rdTest");
    const count = await Banner.countDocuments();
    expect(count).toBeGreaterThanOrEqual(6);
    expect(await Banner.countDocuments({ placement: "HERO" })).toBeGreaterThanOrEqual(3);

    await Banner.deleteMany({ placement: "STRIP" });
    await seedDemoData("Passw0rdTest");
    expect(await Banner.countDocuments({ placement: "STRIP" })).toBe(0);
  });
});
