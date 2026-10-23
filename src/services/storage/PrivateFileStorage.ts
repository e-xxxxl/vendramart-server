export interface PutOptions {
  /** e.g. `payouts/<payoutId>`. */
  folder: string;
  /** Real type, already sniffed from the bytes. */
  mime: string;
  ext: string;
}

export interface PutResult {
  publicId: string;
  /** Provider detail needed to build a download link later (Cloudinary resource type). */
  resourceType?: string;
}

/** How an authorised request gets the file: stream the bytes ourselves, or send the browser to a signed link. */
export type OpenResult = { kind: "buffer"; data: Buffer; mime: string } | { kind: "redirect"; url: string };

/**
 * Storage for files that must NOT be public: payout transfer receipts. Nothing here is ever served by URL;
 * the only way out is `open()`, which our own route calls after checking who is asking.
 */
export interface PrivateFileStorage {
  put(buffer: Buffer, options: PutOptions): Promise<PutResult>;
  open(publicId: string, mime: string, resourceType?: string): Promise<OpenResult>;
  remove(publicId: string, resourceType?: string): Promise<void>;
}
