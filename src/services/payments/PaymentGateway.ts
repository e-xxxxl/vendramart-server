export interface InitializeInput {
  email: string;
  /** Always integer kobo, taken from the stored order total. */
  amountKobo: number;
  /** Our unique reference for this payment attempt. */
  reference: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
}

export interface VerifyResult {
  reference: string;
  /** Normalised: only "success" counts as paid. */
  status: "success" | "failed" | "abandoned" | "pending" | "other";
  amountKobo: number;
  currency: string;
  paystackId?: string;
  channel?: string;
  paidAt?: Date;
}

/** Anything that can take a card payment. Paystack in production; a local stand-in for development. */
export interface PaymentGateway {
  initialize(input: InitializeInput): Promise<{ authorizationUrl: string }>;
  /** Asks the provider (not the webhook payload) what really happened. Null if the provider has never heard of the reference. */
  verify(reference: string): Promise<VerifyResult | null>;
}
