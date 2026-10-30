import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Address } from "../src/models/Address.js";
import { User } from "../src/models/User.js";
import { PASSWORD, api, clearDb, createUser, customerBody, loginToken, startDb, stopDb } from "./helpers.js";

beforeAll(startDb);
afterAll(stopDb);
beforeEach(clearDb);

describe("POST /api/auth/register", () => {
  it("creates a customer, saves the address with lat/lng, and returns a token (no cookie)", async () => {
    const res = await api().post("/api/auth/register").send(customerBody());

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({ role: "CUSTOMER", email: "tolu@example.com" });
    expect(res.body.data.home).toBe("/");
    expect(res.body.data.user.passwordHash).toBeUndefined();

    expect(res.headers["set-cookie"]).toBeUndefined();
    const me = await api().get("/api/auth/me").set("Authorization", `Bearer ${res.body.data.token}`);
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe("tolu@example.com");

    const user = await User.findOne({ email: "tolu@example.com" }).select("+passwordHash");
    expect(user!.passwordHash).not.toContain(PASSWORD); // hashed, never plain

    const addr = await Address.findOne({ userId: user!._id });
    expect(addr).toMatchObject({ isDefault: true, label: "Home" });
    expect(addr!.location).toMatchObject({ lat: 7.4318, lng: 3.9144 });
  });

  it("normalises email and phone", async () => {
    const res = await api()
      .post("/api/auth/register")
      
      .send(customerBody({ email: "  TOLU@Example.com ", phone: "0803 412 7781" }));
    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe("tolu@example.com");
    expect(res.body.data.user.phone).toBe("08034127781");
  });

  it("rejects a duplicate email with 409", async () => {
    await api().post("/api/auth/register").send(customerBody());
    const res = await api().post("/api/auth/register").send(customerBody());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, error: { code: "CONFLICT" } });
  });

  it("rejects bad input with 422 and field details", async () => {
    const res = await api()
      .post("/api/auth/register")
      
      .send(customerBody({ email: "nope", phone: "123", password: "short", address: { line: "x", lat: 99, lng: 3 } }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["email", "phone", "password", "address.line", "address.lat"]));
  });

  it("requires an address", async () => {
    const { address: _omit, ...noAddress } = customerBody();
    const res = await api().post("/api/auth/register").send(noAddress);
    expect(res.status).toBe(422);
  });

  it("ignores a client-supplied role (cannot self-register as admin)", async () => {
    const res = await api()
      .post("/api/auth/register")
      
      .send(customerBody({ role: "ADMIN" }));
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe("CUSTOMER");
  });
});

describe("POST /api/auth/login and GET /me", () => {
  it("logs in, returns the token and the role home path, and /me works with the token", async () => {
    await createUser("ADMIN", "admin@example.com");
    const login = await api().post("/api/auth/login").send({ email: "admin@example.com", password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data).toMatchObject({ home: "/admin", user: { role: "ADMIN" } });
    expect(login.body.data.token).toEqual(expect.any(String));
    expect(login.headers["set-cookie"]).toBeUndefined();
    expect(JSON.stringify(login.body)).not.toContain("passwordHash");

    const token = await loginToken("admin@example.com");
    const me = await api().get("/api/auth/me").set("Authorization", token);
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe("admin@example.com");
  });

  it.each([
    ["VENDOR", "/vendor"],
    ["HANDLER", "/handler"],
    ["CUSTOMER", "/"],
  ] as const)("routes %s to %s", async (role, home) => {
    await createUser(role, "x@example.com");
    const res = await api().post("/api/auth/login").send({ email: "x@example.com", password: PASSWORD });
    expect(res.body.data.home).toBe(home);
  });

  it("gives the same 401 for a wrong password and an unknown email", async () => {
    await createUser("CUSTOMER", "real@example.com");
    const wrongPw = await api().post("/api/auth/login").send({ email: "real@example.com", password: "Wrong1234" });
    const unknown = await api().post("/api/auth/login").send({ email: "ghost@example.com", password: "Wrong1234" });
    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPw.body.error.message).toBe(unknown.body.error.message);
  });

  it("blocks a deactivated account from logging in", async () => {
    const u = await createUser("CUSTOMER", "off@example.com");
    await User.updateOne({ _id: u._id }, { isActive: false });
    const res = await api().post("/api/auth/login").send({ email: "off@example.com", password: PASSWORD });
    expect(res.status).toBe(403);
  });

  it("/me without a token is 401", async () => {
    const res = await api().get("/api/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("only the Authorization header counts: a cookie, a query string or a body field is ignored", async () => {
    await createUser("ADMIN", "admin@example.com");
    const token = (await loginToken("admin@example.com")).replace("Bearer ", "");
    expect((await api().get("/api/auth/me").set("Cookie", `vm_token=${token}`)).status).toBe(401);
    expect((await api().get(`/api/auth/me?token=${token}`)).status).toBe(401);
    expect((await api().get("/api/auth/me").set("Authorization", token)).status).toBe(401); // no "Bearer"
    expect((await api().get("/api/auth/me").set("Authorization", "Bearer")).status).toBe(401);
    expect((await api().get("/api/auth/me").set("Authorization", `bearer ${token}`)).status).toBe(200); // the word is not case sensitive
  });

  it("there is no logout endpoint: signing out is the website forgetting its token", async () => {
    expect((await api().post("/api/auth/logout")).status).toBe(404);
  });
});

describe("response shape", () => {
  it("unknown routes return the standard error shape", async () => {
    const res = await api().get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });

  it("health check works", async () => {
    const res = await api().get("/api/health");
    expect(res.body).toEqual({ success: true, data: { status: "ok" } });
  });
});
