import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { unlockedBefore } from "../src/domain/earnings.js";
import { Notification } from "../src/models/Notification.js";
import { Payout } from "../src/models/Payout.js";
import { SubOrder, type SubOrderDoc } from "../src/models/SubOrder.js";
import { Vendor } from "../src/models/Vendor.js";
import { availableFilter, declinedPayoutIds, loadEarnings } from "../src/modules/earnings/earnings.service.js";
import type { OpenResult, PrivateFileStorage, PutOptions } from "../src/services/storage/PrivateFileStorage.js";
import { setPrivateStorage } from "../src/services/storage/index.js";
import { api, clearDb, createUser, fakeDistance, loginToken, pngBytes, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin, emailLog, paidOrder } from "./fulfilmentHelpers.js";
import { fakeGateway } from "./paymentHelpers.js";

/** Keeps receipts in memory so tests never touch the disk or Cloudinary. */
class FakePrivateStorage implements PrivateFileStorage {
  files = new Map<string, { data: Buffer; mime: string }>();
  async put(buffer: Buffer, { folder, mime, ext }: PutOptions) {
    const publicId = `${folder}/${this.files.size + 1}.${ext}`;
    this.files.set(publicId, { data: buffer, mime });
    return { publicId };
  }
  async open(publicId: string): Promise<OpenResult> {
    const f = this.files.get(publicId);
    if (!f) throw new Error("missing file");
    return { kind: "buffer", data: f.data, mime: f.mime };
  }
  async remove(publicId: string) {
    this.files.delete(publicId);
  }
}
const privateStorage = new FakePrivateStorage();
setPrivateStorage(privateStorage);

const pdfBytes = () => Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
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
  privateStorage.files.clear();
});

let seq = 0;
/** Another sub-order for the same vendor, copied from a real one, with its own ref, earnings, status and delivery time. */
async function addSub(base: SubOrderDoc, over: { earnKobo: number; status: SubOrderDoc["status"]; deliveredAt?: Date }) {
  const raw = base.toObject() as Record<string, unknown>;
  delete raw._id;
  return SubOrder.create({ ...raw, ref: `${base.ref}-X${++seq}`, vendorEarningKobo: over.earnKobo, status: over.status, deliveredAt: over.deliveredAt, payoutId: undefined, payoutLockedAt: undefined });
}

/** Marks the order paidOrder() made for Bodija delivered, then adds the other earnings of the vendor screen. */
async function screenScenario() {
  const o = await paidOrder();
  await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "DELIVERED", deliveredAt: hoursAgo(24 * 8), vendorEarningKobo: 2_000_000 });
  await addSub(o.bodijaSub, { earnKobo: 1_000_000, status: "COMPLETED", deliveredAt: hoursAgo(24 * 9) });
  await addSub(o.bodijaSub, { earnKobo: 1_374_000, status: "COMPLETED", deliveredAt: hoursAgo(24 * 10) });
  await addSub(o.bodijaSub, { earnKobo: 2_700_000, status: "DELIVERED", deliveredAt: hoursAgo(2) }); // still held
  await addSub(o.bodijaSub, { earnKobo: 1_665_000, status: "PICKED_UP" }); // not delivered yet
  const admin = await createAdmin();
  return { ...o, admin, vendor: asUser(o.vendorTokens.bodija), adminApi: asUser(admin.bearer) };
}

function pay(bearer: string, id: string, file?: { data: Buffer; name: string; type: string }) {
  const req = api().post(`/api/admin/payouts/${id}/pay`).set("Authorization", bearer);
  return file ? req.attach("file", file.data, { filename: file.name, contentType: file.type }) : req;
}

describe("vendor earnings summary", () => {
  it("splits money into available, on hold and awaiting delivery (the vendor screen numbers)", async () => {
    const o = await screenScenario();
    const res = await o.vendor.get("/vendor/earnings");
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatchObject({
      availableKobo: 4_374_000,
      availableOrders: 3,
      onHoldKobo: 2_700_000,
      onHoldOrders: 1,
      awaitingKobo: 1_665_000,
      awaitingOrders: 1,
      awaitingOutForDelivery: 1,
      requestedKobo: 0,
      paidKobo: 0,
    });
    expect(new Date(res.body.data.summary.nextUnlockAt).getTime()).toBeGreaterThan(Date.now() + 3 * 24 * HOUR);
    expect(res.body.data.bank).toMatchObject({ bankName: "GTBank", accountMasked: expect.stringMatching(/6789$/) });
    expect(JSON.stringify(res.body)).not.toContain("0123456789");
  });

  it("holds a DELIVERED order until exactly 4 working days after delivery, with no job having run", async () => {
    const o = await paidOrder();
    const base = Date.now();
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "DELIVERED", deliveredAt: new Date(unlockedBefore(new Date(base)).getTime() + 60_000) });
    const summary = async () => (await asUser(o.vendorTokens.bodija).get("/vendor/earnings")).body.data.summary;
    const held = await summary();
    expect(held.availableKobo).toBe(0);
    expect(held.onHoldKobo).toBe(o.bodijaSub.vendorEarningKobo);
    await SubOrder.updateOne({ _id: o.bodijaSub._id }, { deliveredAt: new Date(unlockedBefore(new Date(base)).getTime() - 1000) });
    const released = await summary();
    expect(released.availableKobo).toBe(o.bodijaSub.vendorEarningKobo);
    expect(released.onHoldKobo).toBe(0);
  });

  it("shows a vendor only their own earnings", async () => {
    const o = await screenScenario();
    const res = await asUser(o.vendorTokens.ojaba).get("/vendor/earnings");
    expect(res.body.data.summary.availableKobo).toBe(0);
    expect(res.body.data.rows.every((r: { ref: string }) => r.ref !== o.bodijaSub.ref)).toBe(true);
  });

  it("is for vendors only", async () => {
    const o = await paidOrder();
    expect((await asUser(o.customer.bearer).get("/vendor/earnings")).status).toBe(403);
    expect((await api().get("/api/vendor/earnings")).status).toBe(401);
  });
});

describe("requesting a payout", () => {
  it("takes only what is available, never held or undelivered orders, and tells the admins", async () => {
    const o = await screenScenario();
    const res = await o.vendor.post("/vendor/payouts");
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: "REQUESTED", amountKobo: 4_374_000, number: expect.stringMatching(/^PR-2291$/) });
    expect(res.body.data.receiptUrl).toBeNull();

    const payout = (await Payout.findOne())!;
    expect(payout.subOrderIds).toHaveLength(3);
    expect(payout.bank).toMatchObject({ bankName: "GTBank", accountNumber: "0123456789" });
    expect(await SubOrder.countDocuments({ payoutId: payout._id })).toBe(3);

    const after = (await o.vendor.get("/vendor/earnings")).body.data.summary;
    expect(after).toMatchObject({ availableKobo: 0, requestedKobo: 4_374_000, onHoldKobo: 2_700_000, awaitingKobo: 1_665_000 });

    const note = await Notification.findOne({ userId: o.admin.user._id, kind: "PAYOUT_REQUESTED" });
    expect(note?.title).toContain("PR-2291");
    expect(note?.body).toContain("₦43,740");
  });

  it("refuses when nothing is available", async () => {
    const o = await paidOrder();
    const res = await asUser(o.vendorTokens.bodija).post("/vendor/payouts");
    expect(res.status).toBe(409);
    expect(await Payout.countDocuments()).toBe(0);
  });

  it("cannot be asked twice for the same money", async () => {
    const o = await screenScenario();
    expect((await o.vendor.post("/vendor/payouts")).status).toBe(201);
    expect((await o.vendor.post("/vendor/payouts")).status).toBe(409);
    expect(await Payout.countDocuments()).toBe(1);
  });

  it("survives a double click: exactly one payout is created with everything in it", async () => {
    const o = await screenScenario();
    const results = await Promise.all([o.vendor.post("/vendor/payouts"), o.vendor.post("/vendor/payouts"), o.vendor.post("/vendor/payouts")]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    const payouts = await Payout.find();
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.amountKobo).toBe(4_374_000);
  });

  it("ignores any amount the browser sends", async () => {
    const o = await screenScenario();
    expect((await o.vendor.post("/vendor/payouts", { amountKobo: 99_999_999 })).status).toBe(422);
    expect(await Payout.countDocuments()).toBe(0);
  });

  it("is blocked for a suspended vendor", async () => {
    const o = await screenScenario();
    await Vendor.updateOne({ _id: o.bodija.vendor._id }, { status: "SUSPENDED" });
    expect((await o.vendor.post("/vendor/payouts")).status).toBe(403);
    expect(await Payout.countDocuments()).toBe(0);
  });

  it("frees orders locked to a payout that was never created", async () => {
    const o = await screenScenario();
    await SubOrder.updateMany({ vendorId: o.bodija.vendor._id, status: { $in: ["DELIVERED", "COMPLETED"] }, deliveredAt: { $lte: unlockedBefore(new Date()) } }, { payoutId: new Types.ObjectId() });
    const res = await o.vendor.post("/vendor/payouts");
    expect(res.status).toBe(201);
    expect(res.body.data.amountKobo).toBe(4_374_000);
  });
});

describe("deciding a payout", () => {
  async function requested() {
    const o = await screenScenario();
    const id = (await o.vendor.post("/vendor/payouts")).body.data.id as string;
    return { ...o, id };
  }

  it("lists requests for admins with counts and the full bank details on the detail page", async () => {
    const o = await requested();
    const list = await o.adminApi.get("/admin/payouts");
    expect(list.body.data.counts).toMatchObject({ REQUESTED: 1, PAID: 0, DECLINED: 0 });
    expect(list.body.data.payouts[0]).toMatchObject({ number: "PR-2291", amountKobo: 4_374_000, vendor: { businessName: expect.any(String) } });
    expect(JSON.stringify(list.body)).not.toContain("0123456789");

    const detail = await o.adminApi.get(`/admin/payouts/${o.id}`);
    expect(detail.body.data.bank).toEqual({ bankName: "GTBank", accountNumber: "0123456789", accountName: expect.any(String) });
    expect(detail.body.data.orders).toHaveLength(3);
  });

  it("is for admins only", async () => {
    const o = await requested();
    for (const bearer of [o.vendorTokens.bodija, o.customer.bearer]) {
      expect((await asUser(bearer).get("/admin/payouts")).status).toBe(403);
      expect((await pay(bearer, o.id, { data: pngBytes(), name: "r.png", type: "image/png" })).status).toBe(403);
      expect((await asUser(bearer).post(`/admin/payouts/${o.id}/decline`, { reason: "nope nope" })).status).toBe(403);
    }
    expect((await api().get("/api/admin/payouts")).status).toBe(401);
    expect((await Payout.findById(o.id))!.status).toBe("REQUESTED");
  });

  it("will not mark paid without a receipt, or with a file that is not an image or PDF", async () => {
    const o = await requested();
    expect((await pay(o.admin.bearer, o.id)).status).toBe(422);
    const text = await pay(o.admin.bearer, o.id, { data: Buffer.from("not a receipt"), name: "receipt.png", type: "image/png" });
    expect(text.status).toBe(422);
    expect((await Payout.findById(o.id))!.status).toBe("REQUESTED");
    expect(privateStorage.files.size).toBe(0);
  });

  it("marks paid with an image receipt, stores it privately, and tells the vendor", async () => {
    const o = await requested();
    const res = await pay(o.admin.bearer, o.id, { data: pngBytes(), name: "r.png", type: "image/png" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "PAID", receiptUrl: `/api/payouts/${o.id}/receipt` });
    expect(privateStorage.files.size).toBe(1);

    const stored = (await Payout.findById(o.id))!;
    expect(stored.resolvedBy).toEqual(o.admin.user._id);
    expect(stored.receipt!.mime).toBe("image/png");

    const summary = (await o.vendor.get("/vendor/earnings")).body.data.summary;
    expect(summary).toMatchObject({ paidKobo: 4_374_000, requestedKobo: 0, availableKobo: 0 });
    expect(await Notification.findOne({ userId: o.bodija.user._id, kind: "PAYOUT_PAID" })).not.toBeNull();
  });

  it("accepts a PDF receipt", async () => {
    const o = await requested();
    const res = await pay(o.admin.bearer, o.id, { data: pdfBytes(), name: "transfer.pdf", type: "application/pdf" });
    expect(res.status).toBe(200);
    const file = await asUser(o.vendorTokens.bodija).get(`/payouts/${o.id}/receipt`);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toContain("application/pdf");
  });

  it("cannot be decided twice, and a lost race leaves no stray receipt", async () => {
    const o = await requested();
    expect((await pay(o.admin.bearer, o.id, { data: pngBytes(), name: "r.png", type: "image/png" })).status).toBe(200);
    expect((await pay(o.admin.bearer, o.id, { data: pngBytes(), name: "r.png", type: "image/png" })).status).toBe(409);
    expect((await o.adminApi.post(`/admin/payouts/${o.id}/decline`, { reason: "too late now" })).status).toBe(409);
    expect(privateStorage.files.size).toBe(1);
    expect((await Payout.findById(o.id))!.status).toBe("PAID");
  });

  it("two admins deciding at the same moment: one wins", async () => {
    const o = await requested();
    const results = await Promise.all([
      pay(o.admin.bearer, o.id, { data: pngBytes(), name: "r.png", type: "image/png" }),
      o.adminApi.post(`/admin/payouts/${o.id}/decline`, { reason: "bank details wrong" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const final = (await Payout.findById(o.id))!;
    expect(["PAID", "DECLINED"]).toContain(final.status);
    // The orders are locked if it was paid and free if it was declined, never half and half.
    const locked = await SubOrder.countDocuments({ payoutId: final._id });
    expect(locked).toBe(final.status === "PAID" ? 3 : 0);
    expect(privateStorage.files.size).toBe(final.status === "PAID" ? 1 : 0);
  });

  it("declines with a reason, returns the orders to available, and lets the vendor ask again", async () => {
    const o = await requested();
    expect((await o.adminApi.post(`/admin/payouts/${o.id}/decline`, { reason: "no" })).status).toBe(422);
    expect((await o.adminApi.post(`/admin/payouts/${o.id}/decline`, {})).status).toBe(422);

    const res = await o.adminApi.post(`/admin/payouts/${o.id}/decline`, { reason: "Account name does not match" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "DECLINED", declineReason: "Account name does not match" });
    expect(res.body.data.receiptUrl).toBeNull();

    const summary = (await o.vendor.get("/vendor/earnings")).body.data.summary;
    expect(summary).toMatchObject({ availableKobo: 4_374_000, requestedKobo: 0, paidKobo: 0 });
    const note = await Notification.findOne({ userId: o.bodija.user._id, kind: "PAYOUT_DECLINED" });
    expect(note?.body).toContain("Account name does not match");

    const again = await o.vendor.post("/vendor/payouts");
    expect(again.status).toBe(201);
    expect(again.body.data).toMatchObject({ amountKobo: 4_374_000, number: "PR-2292" });
  });

  it("treats a declined payout's orders as free even if the unlock step never ran", async () => {
    const o = await requested();
    await Payout.updateOne({ _id: o.id }, { status: "DECLINED", declineReason: "interrupted" }); // orders still point at it
    expect(await SubOrder.countDocuments({ payoutId: o.id })).toBe(3);
    expect((await o.vendor.get("/vendor/earnings")).body.data.summary.availableKobo).toBe(4_374_000);
    const res = await o.vendor.post("/vendor/payouts");
    expect(res.status).toBe(201);
    expect(res.body.data.amountKobo).toBe(4_374_000);
  });
});

describe("payout receipts", () => {
  async function paid() {
    const o = await screenScenario();
    const id = (await o.vendor.post("/vendor/payouts")).body.data.id as string;
    await pay(o.admin.bearer, id, { data: pngBytes(), name: "r.png", type: "image/png" });
    return { ...o, id };
  }

  it("opens for the vendor it was paid to and for admins", async () => {
    const o = await paid();
    for (const bearer of [o.vendorTokens.bodija, o.admin.bearer]) {
      const res = await asUser(bearer).get(`/payouts/${o.id}/receipt`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("image/png");
      expect(res.headers["cache-control"]).toContain("no-store");
    }
  });

  it("is a 404 for another vendor, a customer, and anyone signed out", async () => {
    const o = await paid();
    const staff = await createUser("HANDLER", "h@example.com");
    for (const bearer of [o.vendorTokens.ojaba, o.customer.bearer, await loginToken(staff.email)]) {
      expect((await asUser(bearer).get(`/payouts/${o.id}/receipt`)).status).toBe(404);
    }
    expect((await api().get(`/api/payouts/${o.id}/receipt`)).status).toBe(401);
  });

  it("does not exist until the payout is paid", async () => {
    const o = await screenScenario();
    const id = (await o.vendor.post("/vendor/payouts")).body.data.id as string;
    expect((await o.vendor.get(`/payouts/${id}/receipt`)).status).toBe(404);
    expect((await o.vendor.get("/payouts/not-an-id/receipt")).status).toBe(422);
  });

  it("is never reachable by a public URL", async () => {
    const o = await paid();
    const publicId = [...privateStorage.files.keys()][0]!;
    for (const path of [`/uploads/${publicId}`, `/uploads-private/${publicId}`, `/${publicId}`]) {
      expect((await api().get(path)).status, path).toBe(404);
    }
    expect(o.id).toBeTruthy();
  });
});

describe("available means the same thing everywhere", () => {
  it("the withdrawal query and the earnings page agree for every status and delivery time", async () => {
    const o = await paidOrder();
    const now = new Date();
    const times = [undefined, hoursAgo(1), new Date(unlockedBefore(now).getTime() + 1), unlockedBefore(now), hoursAgo(25), hoursAgo(500)];
    for (const status of ["PAID", "READY_FOR_PICKUP", "PICKED_UP", "FAILED_DELIVERY", "DELIVERED", "COMPLETED"] as const) {
      for (const deliveredAt of times) await addSub(o.bodijaSub, { earnKobo: 1000, status, deliveredAt });
    }
    const { results } = await loadEarnings(o.bodija.vendor._id, now);
    const byPage = [...results.entries()].filter(([, r]) => r.state === "AVAILABLE").map(([id]) => id).sort();
    const byQuery = (await SubOrder.find(availableFilter(o.bodija.vendor._id, now, await declinedPayoutIds(o.bodija.vendor._id)))).map((s) => String(s._id)).sort();
    expect(byQuery).toEqual(byPage);
    expect(byQuery.length).toBeGreaterThan(0);
  });
});
