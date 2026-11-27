import { describe, expect, it, vi } from "vitest";
import { CloudinaryPrivateStorage } from "../src/services/storage/CloudinaryPrivateStorage.js";

const config = { cloudName: "demo", apiKey: "key123", apiSecret: "secret456" };
const PUBLIC_ID = "vendramart/payouts/6b05a54c9e23cafaec0a70d9/enjvfzuhrljvqcjqhbtu";

describe("opening a receipt kept in Cloudinary", () => {
  it("asks for a signed private download that expires soon, and hands back the file's bytes", async () => {
    const asked: string[] = [];
    const bytes = Buffer.from("%PDF-1.4 receipt");
    const storage = new CloudinaryPrivateStorage(config, async (url) => {
      asked.push(url);
      return new Response(bytes, { status: 200 });
    });

    const before = Math.floor(Date.now() / 1000);
    const file = await storage.open(PUBLIC_ID, "application/pdf", "image");
    expect(file).toEqual({ kind: "buffer", data: bytes, mime: "application/pdf" });

    expect(asked).toHaveLength(1);
    const url = new URL(asked[0]!);
    expect(url.origin + url.pathname).toBe("https://api.cloudinary.com/v1_1/demo/image/download");
    expect(url.searchParams.get("public_id")).toBe(PUBLIC_ID);
    expect(url.searchParams.get("format")).toBe("pdf");
    expect(url.searchParams.get("type")).toBe("authenticated");
    expect(url.searchParams.get("api_key")).toBe("key123");
    expect(url.searchParams.get("signature")).toMatch(/^[a-f0-9]{40,64}$/);
    // It is not a link to the public delivery network, and it does not last.
    expect(asked[0]).not.toContain("res.cloudinary.com");
    const expires = Number(url.searchParams.get("expires_at"));
    expect(expires).toBeGreaterThan(before);
    expect(expires).toBeLessThanOrEqual(before + 301);
    expect(asked[0]).not.toContain("secret456"); // the secret signs the link; it never travels in it
  });

  it("asks for the right format for each kind of receipt", async () => {
    const formats: Record<string, string | null> = {};
    const storage = new CloudinaryPrivateStorage(config, async (url) => {
      formats[new URL(url).searchParams.get("public_id")!] = new URL(url).searchParams.get("format");
      return new Response("x", { status: 200 });
    });
    await storage.open("a", "image/png");
    await storage.open("b", "image/jpeg");
    await storage.open("c", "image/webp");
    await storage.open("d", "application/pdf");
    expect(formats).toEqual({ a: "png", b: "jpg", c: "webp", d: "pdf" });
  });

  it("says it could not open the receipt, without the provider's words, when Cloudinary refuses", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = new CloudinaryPrivateStorage(config, async () => new Response(JSON.stringify({ error: { message: "deny or ACL failure, key key123" } }), { status: 401 }));
    const err = await storage.open(PUBLIC_ID, "application/pdf").catch((e) => e);
    expect(err).toMatchObject({ status: 503 });
    expect(err.message).toBe("We could not open the receipt right now. Please try again in a moment.");
    expect(err.message).not.toMatch(/ACL|401|key123/);
    expect(String(log.mock.calls[0]![0])).toContain("401"); // the operator's log has the reason
    log.mockRestore();
  });

  it("says the same when Cloudinary cannot be reached at all", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = new CloudinaryPrivateStorage(config, async () => {
      throw new Error("getaddrinfo ENOTFOUND api.cloudinary.com");
    });
    expect(await storage.open(PUBLIC_ID, "image/png").catch((e) => e)).toMatchObject({ status: 503 });
    log.mockRestore();
  });
});
