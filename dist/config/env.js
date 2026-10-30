import "dotenv/config";
import { z } from "zod";
/** Splits a comma separated list of website addresses, dropping blanks and any trailing slash. */
export const splitOrigins = (value) => value
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
/** True when every entry is a plain http(s) address with no path, and there is at least one. */
export function isOriginList(value) {
    const origins = splitOrigins(value);
    return (origins.length > 0 &&
        origins.every((o) => {
            try {
                const u = new URL(o);
                return (u.protocol === "http:" || u.protocol === "https:") && u.origin === o;
            }
            catch {
                return false;
            }
        }));
}
const optionalString = z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));
const schema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    MONGODB_URI: optionalString,
    // The website's address (scheme and host, no path). Several can be listed, separated by commas, for example
    // "https://yourdomain.com,https://www.yourdomain.com". The first is the main one (links in emails, Paystack's return page).
    CLIENT_ORIGIN: z
        .string()
        .default("http://localhost:3000")
        .refine(isOriginList, "CLIENT_ORIGIN must be one or more website addresses like https://www.example.com (no path), separated by commas"),
    // "lax" when the website and the API are on the same site (www.example.com and api.example.com). "none" only if they are
    // on different sites (for example the API on onrender.com); it needs HTTPS and some browsers block such cookies.
    COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    JWT_EXPIRES_IN_DAYS: z.coerce.number().int().positive().default(7),
    COOKIE_NAME: z.string().min(1).default("vm_token"),
    // Only for development: where a browser reaches this API, used in the addresses of locally stored uploads.
    API_PUBLIC_URL: optionalString,
    SEED_ADMIN_EMAIL: optionalString,
    SEED_ADMIN_PASSWORD: optionalString,
    SEED_ADMIN_NAME: optionalString,
    SEED_DEMO_PASSWORD: optionalString,
    CLOUDINARY_CLOUD_NAME: optionalString,
    CLOUDINARY_API_KEY: optionalString,
    CLOUDINARY_API_SECRET: optionalString,
    GOOGLE_MAPS_SERVER_KEY: optionalString,
    PAYSTACK_SECRET_KEY: optionalString,
    PAYSTACK_PUBLIC_KEY: optionalString,
    // Temporary stand-in photos (Unsplash) where a product or category has none. Set to "false" to switch off.
    PLACEHOLDER_IMAGES: optionalString,
    SMTP_HOST: optionalString,
    SMTP_PORT: optionalString,
    SMTP_USER: optionalString,
    SMTP_PASS: optionalString,
    // For email through Resend (https://resend.com). When set, notification emails go through Resend instead of SMTP.
    RESEND_API_KEY: optionalString,
    EMAIL_FROM: optionalString,
});
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    // Fail fast with a readable message instead of a stack trace.
    console.error(`Invalid environment configuration:\n${lines.join("\n")}`);
    console.error("Copy server/.env.example to server/.env and fill in the values.");
    process.exit(1);
}
export const env = parsed.data;
/** Every website address that may call the API from a browser. */
export const clientOrigins = splitOrigins(env.CLIENT_ORIGIN);
/** The main website address: used in emails and as Paystack's return address. */
export const primaryClientOrigin = clientOrigins[0];
export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
