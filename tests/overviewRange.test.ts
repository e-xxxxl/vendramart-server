import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Order } from "../src/models/Order.js";
import { Payout } from "../src/models/Payout.js";
import { SubOrder } from "../src/models/SubOrder.js";
import { api, clearDb, createCustomer, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin, paidOrder } from "./fulfilmentHelpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

const DAY = 86_400_000;
const lagosDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const startOfLagosDay = (day: string) => new Date(`${day}T00:00:00+01:00`);

type Point = { date: string; orders: number; grossKobo: number };
type Sub = { commissionTotalKobo: number };

/**
 * Five paid orders at different ages, so each range picks up a different number of them:
 *   A now · B just inside the 7 day window (five minutes after it starts) · C just outside it (five minutes before)
 *   D 20 days ago · E 100 days ago.
 */
async function fiveOrders() {
  const firstOf7 = startOfLagosDay(lagosDay(new Date(Date.now() - 6 * DAY)));
  const when = {
    A: new Date(),
    B: new Date(firstOf7.getTime() + 5 * 60_000),
    C: new Date(firstOf7.getTime() - 5 * 60_000),
    D: new Date(Date.now() - 20 * DAY),
    E: new Date(Date.now() - 100 * DAY),
  };
  const made: Record<string, Awaited<ReturnType<typeof paidOrder>>> = {};
  for (const [name, paidAt] of Object.entries(when)) {
    const o = await paidOrder();
    await Order.updateOne({ _id: o.order._id }, { "payment.paidAt": paidAt });
    await SubOrder.updateMany({ orderId: o.order._id }, { paidAt });
    made[name] = o;
  }
  return { made, when, admin: await createAdmin() };
}

const overview = async (bearer: string, query = "") => (await asUser(bearer).get(`/admin/overview${query}`)).body.data;
const total = (points: Point[]) => points.reduce((n, p) => n + p.orders, 0);

describe("the overview range", () => {
  it("covers everything when no range is given, as it always did", async () => {
    const { admin } = await fiveOrders();
    const o = await overview(admin.bearer);
    expect(o.range).toBe("all");
    expect(o.sales.orders).toBe(5);
  });

  it("counts only what was paid inside the chosen window: 7 days, 14 days, 30 days, all", async () => {
    const { admin } = await fiveOrders();
    expect((await overview(admin.bearer, "?range=7d")).sales.orders).toBe(2); // A and B; C is five minutes before the window
    expect((await overview(admin.bearer, "?range=14d")).sales.orders).toBe(3); // A, B, C
    expect((await overview(admin.bearer, "?range=30d")).sales.orders).toBe(4); // and D
    expect((await overview(admin.bearer, "?range=all")).sales.orders).toBe(5); // and E
  });

  it("works the sales and delivery fees out for the window, not for ever", async () => {
    const { admin, made } = await fiveOrders();
    const a = (await Order.findById(made.A!.order._id))!;
    const b = (await Order.findById(made.B!.order._id))!;
    const o = await overview(admin.bearer, "?range=7d");
    expect(o.sales).toEqual({ orders: 2, grossKobo: a.totalKobo + b.totalKobo, itemsKobo: a.itemsSubtotalKobo + b.itemsSubtotalKobo, deliveryKobo: a.deliveryTotalKobo + b.deliveryTotalKobo });
  });

  it("works the commission out for the window too", async () => {
    const { admin, made } = await fiveOrders();
    const commissionOf = async (names: string[]) => {
      let sum = 0;
      for (const n of names) for (const s of (await SubOrder.find({ orderId: made[n]!.order._id })) as Sub[]) sum += s.commissionTotalKobo;
      return sum;
    };
    expect((await overview(admin.bearer, "?range=7d")).commissionKobo).toBe(await commissionOf(["A", "B"]));
    expect((await overview(admin.bearer, "?range=14d")).commissionKobo).toBe(await commissionOf(["A", "B", "C"]));
    expect((await overview(admin.bearer, "?range=all")).commissionKobo).toBe(await commissionOf(["A", "B", "C", "D", "E"]));
  });

  it("draws a bar a day for 7, 14 and 30 days, ending today, with empty days as zero", async () => {
    const { admin, when } = await fiveOrders();
    for (const [range, days, orders] of [["7d", 7, 2], ["14d", 14, 3], ["30d", 30, 4]] as const) {
      const { series } = await overview(admin.bearer, `?range=${range}`);
      expect(series.bucket).toBe("day");
      expect(series.points).toHaveLength(days);
      expect(total(series.points)).toBe(orders);
      expect(series.points.at(-1).date).toBe(lagosDay(new Date()));
      expect(series.points[0].date).toBe(lagosDay(new Date(Date.now() - (days - 1) * DAY)));
    }
    const { series } = await overview(admin.bearer, "?range=30d");
    expect(series.points.find((p: Point) => p.date === lagosDay(when.D))).toMatchObject({ orders: 1 });
    expect(series.points.filter((p: Point) => p.orders === 0).length).toBeGreaterThan(20);
  });

  it("draws a bar a month for all time, from the first month with a sale to this month", async () => {
    const { admin, when } = await fiveOrders();
    const { series } = await overview(admin.bearer, "?range=all");
    expect(series.bucket).toBe("month");
    expect(total(series.points)).toBe(5);
    expect(series.points[0].date).toBe(lagosDay(when.E).slice(0, 7));
    expect(series.points.at(-1).date).toBe(lagosDay(new Date()).slice(0, 7));
    // Every month in between is there, once, in order (a quiet month is a zero bar, not a gap).
    const keys = series.points.map((p: Point) => p.date);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(keys);
    for (let i = 1; i < keys.length; i++) {
      const [py, pm] = keys[i - 1].split("-").map(Number);
      const [y, m] = keys[i].split("-").map(Number);
      expect(y * 12 + m - (py * 12 + pm)).toBe(1);
    }
  });

  it("shows one bar for this month, at zero, when there are no sales at all", async () => {
    const admin = await createAdmin();
    const o = await overview(admin.bearer, "?range=all");
    expect(o.series.points).toEqual([{ date: lagosDay(new Date()).slice(0, 7), orders: 0, grossKobo: 0 }]);
    const week = await overview(admin.bearer, "?range=7d");
    expect(week.series.points).toHaveLength(7);
    expect(total(week.series.points)).toBe(0);
  });

  it("always keeps the last 7 days as well, whatever the range", async () => {
    const { admin } = await fiveOrders();
    for (const range of ["7d", "14d", "30d", "all"]) {
      const o = await overview(admin.bearer, `?range=${range}`);
      expect(o.last7Days, range).toHaveLength(7);
      expect(total(o.last7Days), range).toBe(2);
    }
  });

  it("leaves what is happening now alone: vendors, customers, payout requests and the delivery queue do not depend on the range", async () => {
    const { admin, made } = await fiveOrders();
    await Payout.create({ number: "PR-9", vendorId: made.A!.bodija.vendor._id, requestedBy: made.A!.bodija.user._id, amountKobo: 500_000, subOrderIds: [], bank: { bankName: "GTBank", accountNumber: "0123456789", accountName: "Bodija" } });
    await createCustomer();
    const week = await overview(admin.bearer, "?range=7d");
    const all = await overview(admin.bearer, "?range=all");
    for (const key of ["vendors", "customers", "handlers", "payouts", "needsAttention", "deliveries"]) expect(week[key], key).toEqual(all[key]);
    expect(week.payouts).toEqual({ pendingCount: 1, pendingKobo: 500_000 });
  });

  it("refuses a range it does not know, and is only for administrators", async () => {
    const admin = await createAdmin();
    for (const q of ["?range=year", "?range=", "?range=7", "?range=7D"]) expect((await asUser(admin.bearer).get(`/admin/overview${q}`)).status, q).toBe(422);
    const customer = await createCustomer();
    expect((await asUser(customer.bearer).get("/admin/overview?range=7d")).status).toBe(403);
    expect((await api().get("/api/admin/overview?range=7d")).status).toBe(401);
  });
});
