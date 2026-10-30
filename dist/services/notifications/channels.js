import nodemailer from "nodemailer";
import { env, isTest, primaryClientOrigin } from "../../config/env.js";
import { Notification } from "../../models/Notification.js";
import { renderEmail } from "./emailTemplate.js";
/** Shows up in the bell inside the app. */
export class InAppChannel {
    name = "in-app";
    async send(to, m) {
        await Notification.create({ userId: to.id, kind: m.kind, title: m.title, body: m.body, link: m.link });
    }
}
const DEFAULT_FROM = "VendraMart <no-reply@vendramart.test>";
/** What every email channel sends for one notification: a subject, a branded HTML body and a plain-text copy. */
function composeEmail(to, m) {
    const url = m.link ? `${primaryClientOrigin}${m.link}` : primaryClientOrigin;
    const { html, text } = renderEmail({ name: to.name, title: m.title, body: m.body, url, origin: primaryClientOrigin });
    return { subject: m.title, html, text };
}
/**
 * Email through SMTP when SMTP_HOST is configured. Without it (development, tests) nothing is sent: the
 * message is printed to the console instead, so the flow can be seen without any mail account.
 */
export class EmailChannel {
    name = "email";
    transport;
    live;
    constructor() {
        this.live = Boolean(env.SMTP_HOST);
        this.transport = this.live
            ? nodemailer.createTransport({
                host: env.SMTP_HOST,
                port: Number(env.SMTP_PORT ?? 587),
                secure: Number(env.SMTP_PORT) === 465,
                auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
            })
            : nodemailer.createTransport({ jsonTransport: true });
    }
    async send(to, m) {
        await this.transport.sendMail({ from: env.EMAIL_FROM ?? DEFAULT_FROM, to: to.email, ...composeEmail(to, m) });
        if (!this.live && !isTest)
            console.log(`[email not sent, no email service configured] to ${to.email}: ${m.title}`);
    }
}
/**
 * Email through Resend (https://resend.com), used when RESEND_API_KEY is set. It talks to Resend's web address directly
 * rather than through an extra package. The sender (EMAIL_FROM) must be on a domain verified in your Resend account.
 */
export class ResendChannel {
    apiKey;
    from;
    fetchImpl;
    timeoutMs;
    name = "email";
    constructor(apiKey, from = DEFAULT_FROM, fetchImpl = fetch, timeoutMs = 10_000) {
        this.apiKey = apiKey;
        this.from = from;
        this.fetchImpl = fetchImpl;
        this.timeoutMs = timeoutMs;
    }
    async send(to, m) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let res;
        try {
            res = await this.fetchImpl("https://api.resend.com/emails", {
                method: "POST",
                signal: controller.signal,
                headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({ from: this.from, to: [to.email], ...composeEmail(to, m) }),
            });
        }
        catch {
            throw new Error("Resend could not be reached");
        }
        finally {
            clearTimeout(timer);
        }
        if (!res.ok) {
            // Resend explains what is wrong (for example an unverified sender domain). That goes to the log, never to a shopper.
            const reason = (await res.json().catch(() => null))?.message;
            throw new Error(`Resend refused the email (${res.status}${reason ? `: ${String(reason).slice(0, 160)}` : ""})`);
        }
    }
}
/** Resend when it has a key, otherwise SMTP, otherwise the console. */
export function pickEmailChannel(opts = { resendKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }) {
    return opts.resendKey ? new ResendChannel(opts.resendKey, opts.from ?? DEFAULT_FROM) : new EmailChannel();
}
