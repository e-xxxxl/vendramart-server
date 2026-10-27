import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import { detectImageKind } from "../../utils/fileType.js";
import type { ImageStorage, StoredImage, UploadOptions } from "./ImageStorage.js";

export const LOCAL_UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");
export const LOCAL_URL_PREFIX = "/api/uploads";

/** Where this API can be reached from a browser while developing. Set API_PUBLIC_URL if it is not http://localhost:PORT. */
const localOrigin = () => (env.API_PUBLIC_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, "");

/**
 * Development and test fallback used when Cloudinary is not configured. Files land in
 * server/uploads and are served at /api/uploads (see app.ts). Never used in production.
 */
export class LocalDiskStorage implements ImageStorage {
  constructor(private root = LOCAL_UPLOAD_ROOT) {}

  async upload(buffer: Buffer, { folder }: UploadOptions): Promise<StoredImage> {
    // Keep the real extension so the static handler serves the right content type.
    const ext = { jpeg: "jpg", png: "png", webp: "webp" }[detectImageKind(buffer) ?? "jpeg"];
    const id = `${randomUUID()}.${ext}`;
    const publicId = `${folder}/${id}`;
    const target = this.resolve(publicId);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
    // Absolute, because the website is on a different address from this API and would otherwise look for the file on itself.
    return { url: `${localOrigin()}${LOCAL_URL_PREFIX}/${publicId}`, publicId };
  }

  async remove(publicId: string): Promise<void> {
    await fs.rm(this.resolve(publicId), { force: true });
  }

  /** Resolves inside the root only, so a crafted publicId cannot escape it. */
  private resolve(publicId: string): string {
    const target = path.resolve(this.root, publicId);
    if (!target.startsWith(this.root + path.sep)) throw new Error("Invalid storage path");
    return target;
  }
}
