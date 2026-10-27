/**
 * Development and test stand-in for Paystack when no PAYSTACK_SECRET_KEY is set. "Paying" happens on a
 * local page (/dev/paystack) that settles the transaction here and then sends a properly SIGNED webhook
 * through the same code path the real one uses. Transactions live in memory only. Never used in production.
 */
export class DevGateway {
    clientOrigin;
    transactions = new Map();
    constructor(clientOrigin) {
        this.clientOrigin = clientOrigin;
    }
    async initialize({ email, amountKobo, reference }) {
        this.transactions.set(reference, { reference, email, amountKobo, status: "pending" });
        return { authorizationUrl: `${this.clientOrigin}/dev/paystack?reference=${encodeURIComponent(reference)}` };
    }
    async verify(reference) {
        const tx = this.transactions.get(reference);
        if (!tx)
            return null;
        return {
            reference,
            status: tx.status,
            amountKobo: tx.amountKobo,
            currency: "NGN",
            paystackId: `dev-${reference}`,
            channel: "dev",
            paidAt: tx.status === "success" ? new Date() : undefined,
        };
    }
    settle(reference, outcome) {
        const tx = this.transactions.get(reference);
        if (tx)
            tx.status = outcome;
        return tx ?? null;
    }
}
