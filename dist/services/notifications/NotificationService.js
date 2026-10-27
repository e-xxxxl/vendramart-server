/**
 * Sends one message to many people over every configured channel. A channel that fails (SMTP down,
 * bad address) is logged and skipped: it must never break the order action that triggered it, and one
 * failing channel must not stop the others.
 */
export class NotificationService {
    channels;
    constructor(channels) {
        this.channels = channels;
    }
    async notify(recipients, message) {
        const seen = new Set();
        const unique = recipients.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
        const jobs = unique.flatMap((to) => this.channels.map((c) => ({ to, c })));
        const results = await Promise.allSettled(jobs.map(({ to, c }) => c.send(to, message)));
        results.forEach((r, i) => {
            if (r.status === "rejected")
                console.error(`Notification via ${jobs[i].c.name} to ${jobs[i].to.id} failed:`, r.reason?.message ?? r.reason);
        });
    }
}
