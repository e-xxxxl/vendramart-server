import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Notification } from "../src/models/Notification.js";
import { Payout } from "../src/models/Payout.js";
import { SubOrder } from "../src/models/SubOrder.js";
import type { OpenResult, PrivateFileStorage, PutOptions } from "../src/services/storage/PrivateFileStorage.js";
import { setPrivateStorage } from "../src/services/storage/index.js";
import { formatLagosDateTime } from "../src/utils/formatDate.js";
import { api, clearDb, pngBytes, seedReferenceData, startDb, stopDb } from "./helpers.js";
import { asUser, createAdmin, paidOrder } from "./fulfilmentHelpers.js";

/** Keeps receipts in memory so the tests never touch the disk or Cloudinary. */
class FakePrivateStorage implements PrivateFileStorage {
  files = new Map<string, { data: Buffer; mime: string }>();
  async put(buffer: Buffer, { folder, mime, ext }: PutOptions) {
    const publicId = `${folder}/${this.files.size + 1}.${ext}`;
    this.files.set(publicId, { data: buffer, mime });
    return { publicId };
  }
  async open(publicId: string): Promise<OpenResult> {
    const f = this.files.get(publicId)!;
    return { kind: "buffer", data: f.data, mime: f.mime };
  }
  async remove(publicId: string) {
    this.files.delete(publicId);
  }
}
setPrivateStorage(new FakePrivateStorage());

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

const pay = (bearer: string, id: string) => api().post(`/api/admin/payouts/${id}/pay`).set("Authorization", bearer).attach("file", pngBytes(), { filename: "receipt.png", contentType: "image/png" });

/** A vendor with earnings that have cleared the hold, a payout requested, and an admin ready to decide it. */
async function requested() {
  const o = await paidOrder();
  await SubOrder.updateOne({ _id: o.bodijaSub._id }, { status: "DELIVERED", deliveredAt: new Date(Date.now() - 10 * 86_400_000) });
  const admin = await createAdmin();
  const vendor = asUser(o.vendorTokens.bodija);
  const id = (await vendor.post("/vendor/payouts")).body.data.id as string;
  return { ...o, admin, vendor, a: asUser(admin.bearer), id };
}

describe("when a payout was paid", () => {
  it("is captured the moment the admin marks it paid, and not before", async () => {
    const o = await requested();
    const waiting = (await Payout.findById(o.id))!;
    expect(waiting.paidAt).toBeUndefined();
    expect((await o.vendor.get("/vendor/earnings")).body.data.payouts[0].paidAt).toBeNull();

    const before = Date.now();
    const res = await pay(o.admin.bearer, o.id);
    const after = Date.now();
    expect(res.status).toBe(200);

    const stored = (await Payout.findById(o.id))!;
    expect(stored.paidAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(stored.paidAt!.getTime()).toBeLessThanOrEqual(after + 1000);
    expect(stored.paidAt!.getTime()).toBe(stored.resolvedAt!.getTime()); // the same moment
    expect(new Date(res.body.data.paidAt).getTime()).toBe(stored.paidAt!.getTime());
  });

  it("is not set for a payout that was declined", async () => {
    const o = await requested();
    await o.a.post(`/admin/payouts/${o.id}/decline`, { reason: "Account name does not match" });
    const stored = (await Payout.findById(o.id))!;
    expect(stored.status).toBe("DECLINED");
    expect(stored.paidAt).toBeUndefined();
    expect(stored.resolvedAt).toBeInstanceOf(Date);
    const row = (await o.vendor.get("/vendor/earnings")).body.data.payouts[0];
    expect(row).toMatchObject({ status: "DECLINED", paidAt: null });
    expect(row.resolvedAt).not.toBeNull();
  });

  it("stays the same when the payout is looked at again later", async () => {
    const o = await requested();
    await pay(o.admin.bearer, o.id);
    const first = (await Payout.findById(o.id))!.paidAt!.getTime();
    expect((await pay(o.admin.bearer, o.id)).status).toBe(409); // cannot be paid twice
    expect((await Payout.findById(o.id))!.paidAt!.getTime()).toBe(first);
  });

  it("shows to the vendor on their payout history, and to the admin with who paid it", async () => {
    const o = await requested();
    await pay(o.admin.bearer, o.id);
    const stored = (await Payout.findById(o.id))!;

    const vendorRow = (await o.vendor.get("/vendor/earnings")).body.data.payouts[0];
    expect(vendorRow).toMatchObject({ number: "PR-2291", status: "PAID" });
    expect(new Date(vendorRow.paidAt).getTime()).toBe(stored.paidAt!.getTime());
    expect((await o.vendor.get("/vendor/payouts")).body.data[0].paidAt).toBe(vendorRow.paidAt);

    const adminList = (await o.a.get("/admin/payouts?status=PAID")).body.data.payouts[0];
    expect(adminList.paidAt).toBe(vendorRow.paidAt);
    const detail = (await o.a.get(`/admin/payouts/${o.id}`)).body.data;
    expect(detail).toMatchObject({ status: "PAID", paidAt: vendorRow.paidAt, resolvedBy: { id: String(o.admin.user._id), name: o.admin.user.name } });
  });

  it("does not tell the vendor which admin paid it", async () => {
    const o = await requested();
    await pay(o.admin.bearer, o.id);
    const text = JSON.stringify([(await o.vendor.get("/vendor/earnings")).body, (await o.vendor.get("/vendor/payouts")).body]);
    expect(text).not.toContain("resolvedBy");
    expect(text).not.toContain(o.admin.user.name);
  });

  it("falls back on when it was decided for a payout paid before the paid time was kept", async () => {
    const o = await requested();
    await pay(o.admin.bearer, o.id);
    const decidedAt = new Date("2026-10-05T10:15:00Z");
    await Payout.collection.updateOne({ _id: (await Payout.findById(o.id))!._id }, { $set: { resolvedAt: decidedAt }, $unset: { paidAt: "" } });
    const row = (await o.vendor.get("/vendor/earnings")).body.data.payouts[0];
    expect(row.paidAt).toBe(decidedAt.toISOString());
    expect((await o.a.get(`/admin/payouts/${o.id}`)).body.data.paidAt).toBe(decidedAt.toISOString());
  });

  it("is in the message to the vendor, with the date and the time", async () => {
    const o = await requested();
    await pay(o.admin.bearer, o.id);
    const paidAt = (await Payout.findById(o.id))!.paidAt!;
    const note = (await Notification.find({ userId: o.bodija.user._id, kind: "PAYOUT_PAID" }))[0]!;
    expect(note.body).toContain(`on ${formatLagosDateTime(paidAt)}`);
    expect(note.body).toMatch(/was transferred to GTBank on \d{1,2} \w+ \d{4} at \d{2}:\d{2}\./);
  });

  it("is in the bank file as a Paid on column, empty until it is paid", async () => {
    const o = await requested();
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const file = async () => (await o.a.get(`/admin/payouts/export?from=${day}&to=${day}&status=ALL`)).text.replace("﻿", "").trim().split("\r\n");

    let lines = await file();
    expect(lines[0]!.endsWith(",Status,Paid on")).toBe(true);
    expect(lines[1]!.endsWith(",REQUESTED,")).toBe(true);

    await pay(o.admin.bearer, o.id);
    const paidAt = (await Payout.findById(o.id))!.paidAt!;
    const stamp = new Date(paidAt.getTime() + 3_600_000).toISOString().slice(0, 16).replace("T", " ");
    lines = await file();
    expect(lines[1]!.endsWith(`,PAID,${stamp}`)).toBe(true);
  });
});
