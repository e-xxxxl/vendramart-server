import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { XRW, api, startDb, stopDb } from "./helpers.js";

beforeAll(async () => {
  process.env.ENABLE_RATE_LIMIT_IN_TEST = "1";
  await startDb();
});
afterAll(async () => {
  delete process.env.ENABLE_RATE_LIMIT_IN_TEST;
  await stopDb();
});

describe("auth rate limiting", () => {
  it("returns 429 in the standard error shape after 10 attempts", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await api().post("/api/auth/login").set(XRW).send({ email: "a@b.com", password: "Wrong1234" });
      statuses.push(res.status);
      if (res.status === 429) {
        expect(res.body).toMatchObject({ success: false, error: { code: "RATE_LIMITED" } });
      }
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
