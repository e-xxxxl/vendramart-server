import { env, isProd } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import type { ImageStorage } from "./ImageStorage.js";
import { CloudinaryStorage } from "./CloudinaryStorage.js";
import { LocalDiskStorage } from "./LocalDiskStorage.js";

let override: ImageStorage | undefined;
let cached: ImageStorage | undefined;

/** Tests can swap in a fake. */
export function setImageStorage(storage: ImageStorage | undefined) {
  override = storage;
}

export function getImageStorage(): ImageStorage {
  if (override) return override;
  if (cached) return cached;

  if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
    cached = new CloudinaryStorage({
      cloudName: env.CLOUDINARY_CLOUD_NAME,
      apiKey: env.CLOUDINARY_API_KEY,
      apiSecret: env.CLOUDINARY_API_SECRET,
    });
  } else if (!isProd) {
    cached = new LocalDiskStorage();
  } else {
    throw AppError.unavailable("Image storage is not configured");
  }
  return cached;
}

export type { ImageStorage, StoredImage } from "./ImageStorage.js";

// ---- Private files (payout receipts) ----
import type { PrivateFileStorage } from "./PrivateFileStorage.js";
import { CloudinaryPrivateStorage } from "./CloudinaryPrivateStorage.js";
import { LocalPrivateStorage } from "./LocalPrivateStorage.js";

let privateOverride: PrivateFileStorage | undefined;
let privateCached: PrivateFileStorage | undefined;

/** Tests swap in a fake. */
export function setPrivateStorage(storage: PrivateFileStorage | undefined) {
  privateOverride = storage;
}

export function getPrivateStorage(): PrivateFileStorage {
  if (privateOverride) return privateOverride;
  if (privateCached) return privateCached;
  if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
    privateCached = new CloudinaryPrivateStorage({ cloudName: env.CLOUDINARY_CLOUD_NAME, apiKey: env.CLOUDINARY_API_KEY, apiSecret: env.CLOUDINARY_API_SECRET });
  } else if (!isProd) {
    privateCached = new LocalPrivateStorage();
  } else {
    throw AppError.unavailable("File storage is not configured");
  }
  return privateCached;
}

export type { PrivateFileStorage } from "./PrivateFileStorage.js";
