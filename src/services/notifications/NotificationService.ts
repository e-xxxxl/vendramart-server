export interface NotificationMessage {
  /** Machine-readable type, e.g. ORDER_PAID. */
  kind: string;
  title: string;
  body: string;
  /** App path the message points at, e.g. /vendor/orders. */
  link?: string;
}

export interface Recipient {
  id: string;
  name: string;
  email: string;
}

/** One way of reaching a person: in the app, by email, later SMS. */
export interface NotificationChannel {
  readonly name: string;
  send(to: Recipient, message: NotificationMessage): Promise<void>;
}

/**
 * Sends one message to many people over every configured channel. A channel that fails (SMTP down,
 * bad address) is logged and skipped: it must never break the order action that triggered it, and one
 * failing channel must not stop the others.
 */
export class NotificationService {
  constructor(private channels: NotificationChannel[]) {}

  async notify(recipients: Recipient[], message: NotificationMessage): Promise<void> {
    const seen = new Set<string>();
    const unique = recipients.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
    const jobs = unique.flatMap((to) => this.channels.map((c) => ({ to, c })));
    const results = await Promise.allSettled(jobs.map(({ to, c }) => c.send(to, message)));
    results.forEach((r, i) => {
      if (r.status === "rejected") console.error(`Notification via ${jobs[i]!.c.name} to ${jobs[i]!.to.id} failed:`, (r.reason as Error)?.message ?? r.reason);
    });
  }
}
