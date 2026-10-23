import { AppError } from "../../utils/AppError.js";
import type { InitializeInput, PaymentGateway, VerifyResult } from "./PaymentGateway.js";

const BASE = "https://api.paystack.co";
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const UNAVAILABLE = "We could not reach our payment provider. Please try again in a moment.";

/** Top-level names reserved for testing and documentation. Paystack rejects them as "not a valid email". */
const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost", "local"]);

/**
 * The email sent to Paystack. A real customer's address is sent as it is. An address on a reserved test domain (the demo
 * accounts are @vendramart.test) is sent as the same name at example.com, which Paystack accepts, so demo checkouts work.
 * It is only the payer's label on Paystack's side; the order and the receipt still use the address on the account.
 */
export function paystackEmail(email: string): string {
  const [local, domain = ""] = email.trim().toLowerCase().split("@");
  const tld = domain.split(".").at(-1) ?? "";
  return RESERVED_TLDS.has(tld) ? `${local}@example.com` : email.trim();
}

export class PaystackGateway implements PaymentGateway {
  constructor(
    private secretKey: string,
    private fetchImpl: FetchLike = fetch,
    private timeoutMs = 15000,
  ) {}

  private async call(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${BASE}${path}`, {
        method: init.method,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.secretKey}`, "Content-Type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      throw AppError.unavailable(UNAVAILABLE);
    } finally {
      clearTimeout(timer);
    }
  }

  async initialize({ email, amountKobo, reference, callbackUrl, metadata }: InitializeInput) {
    const res = await this.call("/transaction/initialize", {
      method: "POST",
      // Paystack amounts are already in the subunit (kobo), exactly what we store.
      body: { email: paystackEmail(email), amount: amountKobo, currency: "NGN", reference, callback_url: callbackUrl, metadata },
    });
    const json = (await res.json().catch(() => null)) as { status?: boolean; data?: { authorization_url?: string }; message?: string } | null;
    if (!res.ok || !json?.status || !json.data?.authorization_url) {
      // The provider's message can mention keys or account state, so it goes to the log, not the shopper.
      console.error(`Paystack initialize failed (${res.status}): ${String(json?.message ?? "").slice(0, 200)}`);
      throw AppError.unavailable(UNAVAILABLE);
    }
    return { authorizationUrl: json.data.authorization_url };
  }

  async verify(reference: string): Promise<VerifyResult | null> {
    const res = await this.call(`/transaction/verify/${encodeURIComponent(reference)}`, { method: "GET" });
    if (res.status === 404) return null;
    const json = (await res.json().catch(() => null)) as {
      status?: boolean;
      message?: string;
      data?: { status?: string; amount?: number; currency?: string; id?: number; channel?: string; paid_at?: string; reference?: string };
    } | null;
    // Checked against the live Paystack test API: an unknown reference is answered with HTTP 400 and this message, not 404.
    if (res.status === 400 && /reference not found/i.test(json?.message ?? "")) return null;
    if (!res.ok || !json?.status || !json.data) {
      console.error(`Paystack verify failed (${res.status}) for ${reference}`);
      throw AppError.unavailable(UNAVAILABLE);
    }
    const d = json.data;
    const known = ["success", "failed", "abandoned", "pending"] as const;
    return {
      reference: d.reference ?? reference,
      status: (known as readonly string[]).includes(d.status ?? "") ? (d.status as VerifyResult["status"]) : "other",
      amountKobo: typeof d.amount === "number" ? d.amount : -1,
      currency: d.currency ?? "",
      paystackId: d.id === undefined ? undefined : String(d.id),
      channel: d.channel,
      paidAt: d.paid_at ? new Date(d.paid_at) : undefined,
    };
  }
}
