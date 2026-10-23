import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { PaystackGateway, paystackEmail } from "../src/services/payments/PaystackGateway.js";
import { computeSignature, isValidSignature } from "../src/services/payments/signature.js";

const SECRET = "sk_test_abc123";
const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("webhook signature", () => {
  const body = JSON.stringify({ event: "charge.success", data: { reference: "VM-10001-AB12CD34", amount: 3222000 } });

  it("is HMAC-SHA512 of the raw body in lowercase hex, exactly what Paystack documents", () => {
    const expected = createHmac("sha512", SECRET).update(body).digest("hex");
    expect(computeSignature(body, SECRET)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{128}$/);
  });

  it("accepts the correct signature, for string or Buffer bodies", () => {
    const sig = computeSignature(body, SECRET);
    expect(isValidSignature(body, sig, SECRET)).toBe(true);
    expect(isValidSignature(Buffer.from(body), sig, SECRET)).toBe(true);
  });

  it("tolerates surrounding whitespace and upper case in the header", () => {
    const sig = computeSignature(body, SECRET);
    expect(isValidSignature(body, `  ${sig.toUpperCase()} `, SECRET)).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    expect(isValidSignature(body, computeSignature(body, "sk_test_other"), SECRET)).toBe(false);
  });

  it("rejects a body that was changed by even one character (amount tampering)", () => {
    const sig = computeSignature(body, SECRET);
    expect(isValidSignature(body.replace("3222000", "1"), sig, SECRET)).toBe(false);
    expect(isValidSignature(body + " ", sig, SECRET)).toBe(false);
  });

  it("rejects missing, empty, short, long and non-hex headers without throwing", () => {
    for (const bad of [undefined, "", "abc", "z".repeat(128), computeSignature(body, SECRET) + "00", "null", "0".repeat(128)]) {
      expect(isValidSignature(body, bad, SECRET), String(bad)).toBe(false);
    }
  });

  it("never validates against an empty secret", () => {
    expect(isValidSignature(body, computeSignature(body, ""), "")).toBe(false);
  });
});

describe("the email sent to Paystack", () => {
  it("leaves a real address alone", () => {
    expect(paystackEmail("tolu@gmail.com")).toBe("tolu@gmail.com");
    expect(paystackEmail("Tolu.A@Example.NG")).toBe("Tolu.A@Example.NG");
  });

  it("sends addresses on reserved test domains as the same name at example.com, which Paystack accepts", () => {
    for (const email of ["customer@vendramart.test", "a@b.example", "x@host.invalid", "y@something.localhost", "Z@box.local"]) {
      expect(paystackEmail(email), email).toBe(`${email.split("@")[0]!.toLowerCase()}@example.com`);
    }
  });

  it("is what initialize actually posts", async () => {
    const fetchMock = vi.fn(async () => reply(200, { status: true, data: { authorization_url: "https://checkout.paystack.com/x" } }));
    await new PaystackGateway(SECRET, fetchMock as never).initialize({ email: "customer@vendramart.test", amountKobo: 1000, reference: "R1", callbackUrl: "https://shop.example/cb" });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body)).email).toBe("customer@example.com");
  });
});

describe("PaystackGateway.initialize", () => {
  it("posts amount in kobo, NGN, our reference and callback, with the secret key as a bearer token", async () => {
    const fetchMock = vi.fn(async () => reply(200, { status: true, data: { authorization_url: "https://checkout.paystack.com/abc", access_code: "x" } }));
    const gw = new PaystackGateway(SECRET, fetchMock as never);
    const out = await gw.initialize({ email: "tolu@example.com", amountKobo: 3222000, reference: "VM-10001-AAAA1111", callbackUrl: "https://shop.test/checkout/callback?reference=VM-10001-AAAA1111", metadata: { orderId: "o1" } });

    expect(out).toEqual({ authorizationUrl: "https://checkout.paystack.com/abc" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.paystack.co/transaction/initialize");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(init.body as string)).toEqual({
      email: "tolu@example.com",
      amount: 3222000, // kobo, NOT naira
      currency: "NGN",
      reference: "VM-10001-AAAA1111",
      callback_url: "https://shop.test/checkout/callback?reference=VM-10001-AAAA1111",
      metadata: { orderId: "o1" },
    });
  });

  it("turns a Paystack error into a safe 503 and keeps the provider's message out of the response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gw = new PaystackGateway(SECRET, (async () => reply(401, { status: false, message: "Invalid key sk_test_abc123" })) as never);
    const err = await gw.initialize({ email: "a@b.com", amountKobo: 100, reference: "r", callbackUrl: "u" }).catch((e) => e);
    expect(err).toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toMatch(/payment provider/);
    vi.restoreAllMocks();
  });

  it("treats a 200 without an authorization_url as a failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gw = new PaystackGateway(SECRET, (async () => reply(200, { status: true, data: {} })) as never);
    expect(await gw.initialize({ email: "a@b.com", amountKobo: 100, reference: "r", callbackUrl: "u" }).catch((e) => e)).toMatchObject({ status: 503 });
    vi.restoreAllMocks();
  });

  it("turns a network error and a hang into a 503", async () => {
    const down = new PaystackGateway(SECRET, (async () => {
      throw new Error("ECONNRESET");
    }) as never);
    expect(await down.initialize({ email: "a@b.com", amountKobo: 100, reference: "r", callbackUrl: "u" }).catch((e) => e)).toMatchObject({ status: 503 });

    const hang = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as never;
    const slow = new PaystackGateway(SECRET, hang, 30);
    const started = Date.now();
    expect(await slow.initialize({ email: "a@b.com", amountKobo: 100, reference: "r", callbackUrl: "u" }).catch((e) => e)).toMatchObject({ status: 503 });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("PaystackGateway.verify", () => {
  const success = { status: true, data: { status: "success", amount: 3222000, currency: "NGN", id: 4099260516, channel: "card", paid_at: "2026-10-16T10:15:00.000Z", reference: "VM-10001-AAAA1111" } };

  it("calls the verify endpoint for the reference and normalises the result", async () => {
    const fetchMock = vi.fn(async () => reply(200, success));
    const out = await new PaystackGateway(SECRET, fetchMock as never).verify("VM-10001-AAAA1111");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.paystack.co/transaction/verify/VM-10001-AAAA1111");
    expect(init.method).toBe("GET");
    expect(out).toMatchObject({ status: "success", amountKobo: 3222000, currency: "NGN", paystackId: "4099260516", channel: "card" });
    expect(out!.paidAt).toEqual(new Date("2026-10-16T10:15:00.000Z"));
  });

  it("url-encodes the reference so it cannot change the request path", async () => {
    const fetchMock = vi.fn(async () => reply(200, success));
    await new PaystackGateway(SECRET, fetchMock as never).verify("a/b?x=1");
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://api.paystack.co/transaction/verify/a%2Fb%3Fx%3D1");
  });

  it("maps abandoned, failed, pending and unknown statuses; only success means paid", async () => {
    for (const [raw, expected] of [["abandoned", "abandoned"], ["failed", "failed"], ["pending", "pending"], ["reversed", "other"], ["ongoing", "other"]] as const) {
      const gw = new PaystackGateway(SECRET, (async () => reply(200, { status: true, data: { ...success.data, status: raw } })) as never);
      expect((await gw.verify("r"))!.status, raw).toBe(expected);
    }
  });

  it("returns null when Paystack has never heard of the reference (404)", async () => {
    const gw = new PaystackGateway(SECRET, (async () => reply(404, { status: false, message: "Transaction reference not found" })) as never);
    expect(await gw.verify("nope")).toBeNull();
  });

  it("returns null for the HTTP 400 the live Paystack API sends for an unknown reference, but not for other 400s", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const unknown = new PaystackGateway(SECRET, (async () => reply(400, { status: false, message: "Transaction reference not found" })) as never);
    expect(await unknown.verify("nope")).toBeNull();
    const other = new PaystackGateway(SECRET, (async () => reply(400, { status: false, message: "Invalid key" })) as never);
    await expect(other.verify("r")).rejects.toMatchObject({ status: 503 });
  });

  it("reports a missing amount as -1 so it can never equal an order total", async () => {
    const gw = new PaystackGateway(SECRET, (async () => reply(200, { status: true, data: { status: "success", currency: "NGN" } })) as never);
    expect((await gw.verify("r"))!.amountKobo).toBe(-1);
  });

  it("throws a safe 503 on server errors, bad JSON and network failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const fetchImpl of [
      async () => reply(500, "boom"),
      async () => reply(200, "<html>"),
      async () => {
        throw new Error("down");
      },
    ]) {
      const err = await new PaystackGateway(SECRET, fetchImpl as never).verify("r").catch((e) => e);
      expect(err).toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
    }
    vi.restoreAllMocks();
  });
});
