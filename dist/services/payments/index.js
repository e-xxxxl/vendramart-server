import { env, isProd, primaryClientOrigin } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { DevGateway } from "./DevGateway.js";
import { PaystackGateway } from "./PaystackGateway.js";
export const DEV_WEBHOOK_SECRET = "dev-paystack-webhook-secret";
let override;
let cached;
/** Tests swap in a fake gateway and webhook secret. */
export function setPaymentGateway(gateway, secret = "test-paystack-secret") {
    override = gateway ? { gateway, secret, dev: gateway instanceof DevGateway ? gateway : undefined } : undefined;
}
function build() {
    if (env.PAYSTACK_SECRET_KEY)
        return { gateway: new PaystackGateway(env.PAYSTACK_SECRET_KEY), secret: env.PAYSTACK_SECRET_KEY };
    if (!isProd) {
        const dev = new DevGateway(primaryClientOrigin);
        return { gateway: dev, secret: DEV_WEBHOOK_SECRET, dev };
    }
    // Fail loudly rather than pretend to take payments.
    const unavailable = async () => {
        throw AppError.unavailable("Payments are not configured");
    };
    return { gateway: { initialize: unavailable, verify: unavailable }, secret: "" };
}
const current = () => override ?? (cached ??= build());
export const getPaymentGateway = () => current().gateway;
export const getWebhookSecret = () => current().secret;
/** Only set when running on the dev stand-in. */
export const getDevGateway = () => current().dev;
