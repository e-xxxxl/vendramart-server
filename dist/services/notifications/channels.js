import nodemailer from "nodemailer";
import { env, isTest } from "../../config/env.js";
import { Notification } from "../../models/Notification.js";
/** Shows up in the bell inside the app. */
export class InAppChannel {
    name = "in-app";
    async send(to, m) {
        await Notification.create({ userId: to.id, kind: m.kind, title: m.title, body: m.body, link: m.link });
    }
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
        const url = m.link ? `${env.CLIENT_ORIGIN}${m.link}` : env.CLIENT_ORIGIN;
        const text = `Hi ${to.name.split(" ")[0]},\n\n${m.body}\n\nOpen VendraMart: ${url}\n\nVendraMart`;
        await this.transport.sendMail({ from: env.EMAIL_FROM ?? "VendraMart <no-reply@vendramart.test>", to: to.email, subject: m.title, text });
        if (!this.live && !isTest)
            console.log(`[email not sent, no SMTP configured] to ${to.email}: ${m.title}`);
    }
}
