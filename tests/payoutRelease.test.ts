import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Payout } from "../src/models/Payout.js";
import { SubOrder } from "../src/models/SubOrder.js";
import { Vendor } from "../src/models/Vendor.js";
import { fakeDistance, seedReferenceData, startDb, stopDb, clearDb } from "./helpers.js";
import { asUser, createAdmin, emailLog, paidOrder } from "./fulfilmentHelpers.js";
import { fakeGateway } from "./paymentHelpers.js";

const HOUR = 3600_000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
  fakeDistance.reset();
  fakeGateway.reset();
  emailLog.reset();
});

/** Both vendors' deliveries are old enough to be paid: Bodija 8 days ago, Ojaba 8 days ago. */
async function readyScenario() {
  const o = await paidOrder();
  await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "DELIVERED", deliveredAt: hoursAgo(24 * 8), vendorEarningKobo: 2_000_000 });
  await SubOrder.updateOne({ _id: o.ojabaSub._id }, { status: "COMPLETED", deliveredAt: hoursAgo(24 * 9), vendorEarningKobo: 500_000 });
  const admin = await createAdmin();
  return { ...o, adminApi: asUser(admin.bearer), admin, bodijaApi: asUser(o.vendorTokens.bodija) };
}

describe("earnings that are ready to be released", () => {
  it("lists every vendor whose hold is over, without anyone asking, with their whole balance", async () => {
    const o = await readyScenario();
    const res = await o.adminApi.get("/admin/payouts/due");
    expect(res.status).toBe(200);
    expect(res.body.data.totalKobo).toBe(2_500_000);
    const bodija = res.body.data.rows.find((r: { vendor: { id: string } }) => r.vendor.id === String(o.bodija.vendor._id));
    expect(bodija).toMatchObject({ dueKobo: 2_000_000, deliveries: 1, canRelease: true, blockedReason: null });
    expect(bodija.balance).toMatchObject({ readyKobo: 2_000_000, inPayoutKobo: 0, onHoldKobo: 0, paidKobo: 0, owedKobo: 2_000_000 });
  });

  it("leaves out a delivery still in its hold, one with an open return, and one already in a payout", async () => {
    const o = await readyScenario();
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { deliveredAt: hoursAgo(2) }); // still in the hold
    await SubOrder.updateOne({ _id: o.ojabaSub._id }, { returnHold: true }); // a return is open
    const res = await o.adminApi.get("/admin/payouts/due");
    expect(res.body.data.rows).toEqual([]);

    await SubOrder.updateOne({ _id: o.ojabaSub._id }, { returnHold: false });
    expect((await o.adminApi.get("/admin/payouts/due")).body.data.rows).toHaveLength(1);
    await asUser(o.vendorTokens.ojaba).post("/vendor/payouts", {}); // the vendor asks first
    expect((await o.adminApi.get("/admin/payouts/due")).body.data.rows).toEqual([]);
  });

  it("takes refunds off what is due, and drops a delivery refunded in full", async () => {
    const o = await readyScenario();
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { returnedEarningKobo: 500_000 });
    await SubOrder.updateOne({ _id: o.ojabaSub._id }, { returnedEarningKobo: 500_000 });
    const res = await o.adminApi.get("/admin/payouts/due");
    expect(res.body.data.rows).toHaveLength(1);
    expect(res.body.data.totalKobo).toBe(1_500_000);
  });

  it("is for the admin side only", async () => {
    const o = await readyScenario();
    expect((await o.bodijaApi.get("/admin/payouts/due")).status).toBe(403);
    expect((await o.bodijaApi.post("/admin/payouts/release", {})).status).toBe(403);
  });
});

describe("releasing ready earnings", () => {
  it("makes a payout for each vendor, labelled as released by the admin, and the earnings leave the ready list", async () => {
    const o = await readyScenario();
    const res = await o.adminApi.post("/admin/payouts/release", {});
    expect(res.status).toBe(200);
    expect(res.body.data.released).toHaveLength(2);
    expect(res.body.data.skipped).toEqual([]);

    const payouts = await Payout.find({}).sort({ amountKobo: -1 });
    expect(payouts.map((p) => [p.amountKobo, p.source, p.status])).toEqual([
      [2_000_000, "ADMIN_RELEASE", "REQUESTED"],
      [500_000, "ADMIN_RELEASE", "REQUESTED"],
    ]);
    expect(String(payouts[0]!.requestedBy)).toBe(String(o.admin.user._id));
    expect((await o.adminApi.get("/admin/payouts/due")).body.data.rows).toEqual([]);

    // The vendor sees it as an earning already in a payout, so it can not be asked for again.
    const earnings = await o.bodijaApi.get("/vendor/earnings");
    expect(earnings.body.data.summary).toMatchObject({ availableKobo: 0, requestedKobo: 2_000_000 });
    expect((await o.bodijaApi.post("/vendor/payouts", {})).status).toBe(409);
  });

  it("releases only the vendors chosen", async () => {
    const o = await readyScenario();
    const res = await o.adminApi.post("/admin/payouts/release", { vendorIds: [String(o.ojaba.vendor._id)] });
    expect(res.body.data.released).toHaveLength(1);
    expect(res.body.data.released[0].businessName).toBe(o.ojaba.vendor.businessName);
    expect((await o.adminApi.get("/admin/payouts/due")).body.data.rows).toHaveLength(1);
  });

  it("can not release the same earnings twice", async () => {
    const o = await readyScenario();
    await o.adminApi.post("/admin/payouts/release", {});
    const again = await o.adminApi.post("/admin/payouts/release", {});
    expect(again.body.data.released).toEqual([]);
    expect(await Payout.countDocuments()).toBe(2);
  });

  it("skips a suspended store and says why, and offers it as blocked in the list", async () => {
    const o = await readyScenario();
    await Vendor.updateOne({ _id: o.ojaba.vendor._id }, { status: "SUSPENDED" });
    const list = await o.adminApi.get("/admin/payouts/due");
    const blocked = list.body.data.rows.find((r: { vendor: { id: string } }) => r.vendor.id === String(o.ojaba.vendor._id));
    expect(blocked).toMatchObject({ canRelease: false, blockedReason: "The store is suspended" });
    expect(list.body.data.releasableKobo).toBe(2_000_000);

    const res = await o.adminApi.post("/admin/payouts/release", {});
    expect(res.body.data.released).toHaveLength(1);
    expect(res.body.data.skipped).toEqual([{ vendorId: String(o.ojaba.vendor._id), businessName: o.ojaba.vendor.businessName, reason: "The store is suspended" }]);
  });

  it("returns a declined release to the ready list", async () => {
    const o = await readyScenario();
    const released = (await o.adminApi.post("/admin/payouts/release", {})).body.data.released[0] as { payoutId: string };
    await o.adminApi.post(`/admin/payouts/${released.payoutId}/decline`, { reason: "Bank name was wrong" });
    expect((await o.adminApi.get("/admin/payouts/due")).body.data.rows).toHaveLength(1);
  });

  it("only accepts real vendor ids", async () => {
    const o = await readyScenario();
    expect((await o.adminApi.post("/admin/payouts/release", { vendorIds: ["nope"] })).status).toBe(422);
    expect((await o.adminApi.post("/admin/payouts/release", { vendorIds: [] })).status).toBe(422);
    expect((await o.adminApi.post("/admin/payouts/release", { amountKobo: 5 })).status).toBe(422);
  });
});

describe("segments and the vendor's balance on payouts", () => {
  it("tells vendor requests from admin releases, and counts each", async () => {
    const o = await readyScenario();
    await asUser(o.vendorTokens.ojaba).post("/vendor/payouts", {}); // requested by the vendor
    await o.adminApi.post("/admin/payouts/release", {}); // Bodija's, released by the admin

    const mine = await o.adminApi.get("/admin/payouts?status=REQUESTED&source=VENDOR_REQUEST");
    expect(mine.body.data.payouts.map((p: { source: string; amountKobo: number }) => [p.source, p.amountKobo])).toEqual([["VENDOR_REQUEST", 500_000]]);
    const released = await o.adminApi.get("/admin/payouts?status=REQUESTED&source=ADMIN_RELEASE");
    expect(released.body.data.payouts.map((p: { source: string; amountKobo: number }) => [p.source, p.amountKobo])).toEqual([["ADMIN_RELEASE", 2_000_000]]);
    expect(released.body.data.counts).toMatchObject({ requestedByVendors: 1, released: 1, REQUESTED: 2 });

    // The vendor sees the same label on their own history.
    const history = await asUser(o.vendorTokens.ojaba).get("/vendor/payouts");
    expect(history.body.data[0].source).toBe("VENDOR_REQUEST");
  });

  it("treats a payout from before sources existed as requested by the vendor", async () => {
    const o = await readyScenario();
    await asUser(o.vendorTokens.ojaba).post("/vendor/payouts", {});
    await Payout.collection.updateMany({}, { $unset: { source: 1 } });
    const res = await o.adminApi.get("/admin/payouts?status=REQUESTED&source=VENDOR_REQUEST");
    expect(res.body.data.payouts).toHaveLength(1);
    expect(res.body.data.payouts[0].source).toBe("VENDOR_REQUEST");
    expect((await o.adminApi.get("/admin/payouts?status=REQUESTED&source=ADMIN_RELEASE")).body.data.payouts).toEqual([]);
  });

  it("shows the vendor's whole balance on each payout, in the list and in the detail", async () => {
    const o = await readyScenario();
    // Bodija: 2,000,000 asked for. Another 300,000 still in the hold, and 700,000 delivered long ago and still ready.
    const extra = (await SubOrder.findById(o.bodijaSub._id))!.toObject() as Record<string, unknown>;
    delete extra._id;
    await bodijaPayout(o);
    await SubOrder.create({ ...extra, ref: `${o.bodijaSub.ref}-H`, vendorEarningKobo: 300_000, status: "DELIVERED", deliveredAt: hoursAgo(2), payoutId: undefined, payoutLockedAt: undefined });
    await SubOrder.create({ ...extra, ref: `${o.bodijaSub.ref}-R`, vendorEarningKobo: 700_000, status: "COMPLETED", deliveredAt: hoursAgo(24 * 12), payoutId: undefined, payoutLockedAt: undefined });

    const list = await o.adminApi.get("/admin/payouts?status=REQUESTED");
    const row = list.body.data.payouts.find((p: { amountKobo: number }) => p.amountKobo === 2_000_000);
    expect(row.balance).toEqual({ readyKobo: 700_000, inPayoutKobo: 2_000_000, onHoldKobo: 300_000, awaitingDeliveryKobo: 0, paidKobo: 0, owedKobo: 3_000_000 });

    const detail = await o.adminApi.get(`/admin/payouts/${row.id}`);
    expect(detail.body.data.balance).toEqual(row.balance);
  });
});

async function bodijaPayout(o: Awaited<ReturnType<typeof readyScenario>>) {
  const res = await o.bodijaApi.post("/vendor/payouts", {});
  expect(res.status).toBe(201);
}
