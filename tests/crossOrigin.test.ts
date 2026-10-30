import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clientOrigins, isOriginList, primaryClientOrigin, splitOrigins } from "../src/config/env.js";
import { adminPayoutPage, deliveryPage, orderPage } from "../src/utils/webLinks.js";
import { PASSWORD, api, clearDb, createUser, seedReferenceData, startDb, stopDb } from "./helpers.js";

const WEBSITE = "http://localhost:3000"; // CLIENT_ORIGIN in tests/setupEnv.ts

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  await seedReferenceData();
});

describe("the website calling the API from its own address", () => {
  it("answers the browser's pre-flight check for the website, allowing the Authorization header", async () => {
    const res = await api()
      .options("/api/auth/login")
      .set("Origin", WEBSITE)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,authorization");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(WEBSITE);
    // No cookies are used, so the browser is never told to send or accept credentials.
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers["access-control-allow-headers"]).toMatch(/authorization/i);
    expect(res.headers["access-control-max-age"]).toBe("86400");
  });

  it("also allows the methods the dashboards use (PUT, PATCH, DELETE)", async () => {
    const res = await api().options("/api/admin/settings").set("Origin", WEBSITE).set("Access-Control-Request-Method", "PUT");
    expect(res.headers["access-control-allow-methods"]).toMatch(/PUT/);
    expect(res.headers["access-control-allow-methods"]).toMatch(/PATCH/);
    expect(res.headers["access-control-allow-methods"]).toMatch(/DELETE/);
  });

  it("gives no permission to any other website", async () => {
    const pre = await api().options("/api/auth/login").set("Origin", "https://evil.example").set("Access-Control-Request-Method", "POST");
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
    const get = await api().get("/api/health").set("Origin", "https://evil.example");
    expect(get.status).toBe(200);
    // Without an allow-origin header the browser refuses to hand the response to the other website, whatever else is sent.
    expect(get.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("lets the website read normal responses, and lets images be loaded from another address", async () => {
    const res = await api().get("/api/health").set("Origin", WEBSITE);
    expect(res.headers["access-control-allow-origin"]).toBe(WEBSITE);
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("signs in from the website with a token in the answer, and never sets a cookie", async () => {
    await createUser("CUSTOMER", "tolu@example.com");
    const login = await api().post("/api/auth/login").set("Origin", WEBSITE).send({ email: "tolu@example.com", password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.token).toEqual(expect.any(String));
    expect(login.headers["set-cookie"]).toBeUndefined();
    expect(login.headers["access-control-allow-origin"]).toBe(WEBSITE);
  });

  it("the signed-in website can call the API with its token from another address", async () => {
    await createUser("CUSTOMER", "tolu@example.com");
    const login = await api().post("/api/auth/login").send({ email: "tolu@example.com", password: PASSWORD });
    const me = await api().get("/api/auth/me").set("Origin", WEBSITE).set("Authorization", `Bearer ${login.body.data.token}`);
    expect(me.status).toBe(200);
    expect(me.headers["access-control-allow-origin"]).toBe(WEBSITE);
  });
});

describe("the website address setting", () => {
  it("reads a single address, and a list of addresses with the first as the main one", () => {
    expect(splitOrigins("https://a.com")).toEqual(["https://a.com"]);
    expect(splitOrigins(" https://a.com/ , https://www.a.com ,, ")).toEqual(["https://a.com", "https://www.a.com"]);
    expect(clientOrigins).toEqual([WEBSITE]);
    expect(primaryClientOrigin).toBe(WEBSITE);
  });

  it("accepts addresses with a scheme and host, and rejects anything else", () => {
    for (const ok of ["http://localhost:3000", "https://www.example.com", "https://a.com,https://www.a.com", "https://a.com/"]) expect(isOriginList(ok), ok).toBe(true);
    for (const bad of ["", " ", "example.com", "www.example.com", "https://a.com/shop", "ftp://a.com", "https://a.com,example.org", "javascript:alert(1)", "https://a.com?x=1"]) {
      expect(isOriginList(bad), bad).toBe(false);
    }
  });
});

describe("page addresses used in notifications", () => {
  it("point at the single pages of the static website, naming the record after a question mark", () => {
    expect(orderPage("abc")).toBe("/order/?id=abc");
    expect(deliveryPage("abc")).toBe("/handler/delivery/?id=abc");
    expect(adminPayoutPage("abc")).toBe("/admin/payouts/?id=abc");
  });
});
