import { env, isProd } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { DevGateway } from "./DevGateway.js";
import type { PaymentGateway } from "./PaymentGateway.js";
import { PaystackGateway } from "./PaystackGateway.js";

export const DEV_WEBHOOK_SECRET = "dev-paystack-webhook-secret";

interface Built {
  gateway: PaymentGateway;
  /** The key Paystack signs webhooks with (your secret key). */
  secret: string;
  dev?: DevGateway;
}

let override: Built | undefined;
let cached: Built | undefined;

/** Tests swap in a fake gateway and webhook secret. */
export function setPaymentGateway(gateway: PaymentGateway | undefined, secret = "test-paystack-secret") {
  override = gateway ? { gateway, secret, dev: gateway instanceof DevGateway ? gateway : undefined } : undefined;
}

function build(): Built {
  if (env.PAYSTACK_SECRET_KEY) return { gateway: new PaystackGateway(env.PAYSTACK_SECRET_KEY), secret: env.PAYSTACK_SECRET_KEY };
  if (!isProd) {
    const dev = new DevGateway(env.CLIENT_ORIGIN);
    return { gateway: dev, secret: DEV_WEBHOOK_SECRET, dev };
  }
  // Fail loudly rather than pretend to take payments.
  const unavailable = async (): Promise<never> => {
    throw AppError.unavailable("Payments are not configured");
  };
  return { gateway: { initialize: unavailable, verify: unavailable }, secret: "" };
}

const current = (): Built => override ?? (cached ??= build());

export const getPaymentGateway = (): PaymentGateway => current().gateway;
export const getWebhookSecret = (): string => current().secret;
/** Only set when running on the dev stand-in. */
export const getDevGateway = (): DevGateway | undefined => current().dev;

export type { PaymentGateway } from "./PaymentGateway.js";
