import { v2 as cloudinary } from "cloudinary";
import { AppError } from "../../utils/AppError.js";
import type { OpenResult, PrivateFileStorage, PutOptions, PutResult } from "./PrivateFileStorage.js";

type FetchLike = (url: string) => Promise<Response>;

/** The file extension Cloudinary needs to build a download for each kind of receipt we accept. */
const EXTENSION: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/**
 * Cloudinary "authenticated" assets: they cannot be fetched at a plain URL. Our own route has already checked who is asking
 * (the owning vendor or an admin) before `open` is called.
 *
 * `open` does not send the browser to a Cloudinary delivery link. A signed delivery link for a PDF is refused by Cloudinary
 * ("deny or ACL failure", 401), and any link handed to a browser can be passed around. Instead the API asks Cloudinary for a
 * private download (a link signed with our API secret that expires in five minutes, which is how Cloudinary serves private
 * assets), fetches the file itself, and streams the bytes to the person who was just checked.
 */
export class CloudinaryPrivateStorage implements PrivateFileStorage {
  constructor(
    cfg: { cloudName: string; apiKey: string; apiSecret: string },
    private fetchImpl: FetchLike = (url) => fetch(url),
  ) {
    cloudinary.config({ cloud_name: cfg.cloudName, api_key: cfg.apiKey, api_secret: cfg.apiSecret, secure: true });
  }

  put(buffer: Buffer, { folder }: PutOptions): Promise<PutResult> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ folder, resource_type: "auto", type: "authenticated" }, (err, result) => {
        if (err || !result) return reject(err ?? new Error("Cloudinary returned no result"));
        resolve({ publicId: result.public_id, resourceType: result.resource_type });
      });
      stream.end(buffer);
    });
  }

  async open(publicId: string, mime: string, resourceType = "image"): Promise<OpenResult> {
    const format = EXTENSION[mime] ?? mime.split("/")[1] ?? "bin";
    const url = cloudinary.utils.private_download_url(publicId, format, {
      resource_type: resourceType,
      type: "authenticated",
      expires_at: Math.floor(Date.now() / 1000) + 300,
    });

    let res: Response;
    try {
      res = await this.fetchImpl(url);
    } catch (err) {
      console.error("Could not reach Cloudinary to open a receipt:", (err as Error).message);
      throw AppError.unavailable("We could not open the receipt right now. Please try again in a moment.");
    }
    if (!res.ok) {
      // The reason is for the operator's log; the person only needs to know it did not open.
      console.error(`Cloudinary would not give up a receipt (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
      throw AppError.unavailable("We could not open the receipt right now. Please try again in a moment.");
    }
    return { kind: "buffer", data: Buffer.from(await res.arrayBuffer()), mime };
  }

  async remove(publicId: string, resourceType = "image"): Promise<void> {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, type: "authenticated" });
  }
}
