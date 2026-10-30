import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { User, type Role } from "../src/models/User.js";
import { api, clearDb, createUser, loginToken, startDb, stopDb } from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

const AREAS = { ADMIN: "admin", VENDOR: "vendor", HANDLER: "handler", CUSTOMER: "me" } as const;
const ROLES = Object.keys(AREAS) as Role[];

describe("requireRole on every role area", () => {
  it("returns 401 with no session", async () => {
    for (const area of Object.values(AREAS)) {
      const res = await api().get(`/api/${area}/ping`);
      expect(res.status, area).toBe(401);
    }
  });

  // Full matrix: 4 roles x 4 areas. Only the matching pair may pass.
  for (const role of ROLES) {
    for (const [areaRole, area] of Object.entries(AREAS)) {
      const allowed = role === areaRole;
      it(`${role} -> /api/${area}/ping is ${allowed ? "200" : "403"}`, async () => {
        await createUser(role, "u@example.com");
        const token = await loginToken("u@example.com");
        const res = await api().get(`/api/${area}/ping`).set("Authorization", token);
        expect(res.status).toBe(allowed ? 200 : 403);
        if (!allowed) expect(res.body.error.code).toBe("FORBIDDEN");
      });
    }
  }

  it("takes effect immediately when an account is deactivated mid-session", async () => {
    const u = await createUser("ADMIN", "boss@example.com");
    const token = await loginToken("boss@example.com");
    expect((await api().get("/api/admin/ping").set("Authorization", token)).status).toBe(200);

    await User.updateOne({ _id: u._id }, { isActive: false });
    expect((await api().get("/api/admin/ping").set("Authorization", token)).status).toBe(401);
  });

  it("uses the role stored in the database, not the one inside the token", async () => {
    const u = await createUser("CUSTOMER", "c@example.com");
    // Token claims ADMIN, but the DB says CUSTOMER.
    const forged = jwt.sign({ sub: String(u._id), role: "ADMIN" }, process.env.JWT_SECRET!);
    const res = await api().get("/api/admin/ping").set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(403);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const u = await createUser("ADMIN", "a@example.com");
    const bad = jwt.sign({ sub: String(u._id), role: "ADMIN" }, "some-other-secret-some-other-secret-1");
    const res = await api().get("/api/admin/ping").set("Authorization", `Bearer ${bad}`);
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const u = await createUser("ADMIN", "a@example.com");
    const expired = jwt.sign({ sub: String(u._id), role: "ADMIN" }, process.env.JWT_SECRET!, { expiresIn: -10 });
    const res = await api().get("/api/admin/ping").set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });
});
