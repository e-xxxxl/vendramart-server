import { createHmac, timingSafeEqual } from "node:crypto";
/** Paystack signs the RAW request body with HMAC-SHA512 using your secret key and sends it in x-paystack-signature. */
export function computeSignature(rawBody, secret) {
    return createHmac("sha512", secret).update(rawBody).digest("hex");
}
/** Constant-time comparison; false for a missing, malformed or wrong-length header. */
export function isValidSignature(rawBody, header, secret) {
    if (!header || !secret)
        return false;
    const expected = Buffer.from(computeSignature(rawBody, secret), "utf8");
    const given = Buffer.from(header.trim().toLowerCase(), "utf8");
    return expected.length === given.length && timingSafeEqual(expected, given);
}
