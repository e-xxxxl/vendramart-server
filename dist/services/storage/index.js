import { env, isProd } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { CloudinaryStorage } from "./CloudinaryStorage.js";
import { LocalDiskStorage } from "./LocalDiskStorage.js";
let override;
let cached;
/** Tests can swap in a fake. */
export function setImageStorage(storage) {
    override = storage;
}
export function getImageStorage() {
    if (override)
        return override;
    if (cached)
        return cached;
    if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
        cached = new CloudinaryStorage({
            cloudName: env.CLOUDINARY_CLOUD_NAME,
            apiKey: env.CLOUDINARY_API_KEY,
            apiSecret: env.CLOUDINARY_API_SECRET,
        });
    }
    else if (!isProd) {
        cached = new LocalDiskStorage();
    }
    else {
        throw AppError.unavailable("Image storage is not configured");
    }
    return cached;
}
import { CloudinaryPrivateStorage } from "./CloudinaryPrivateStorage.js";
import { LocalPrivateStorage } from "./LocalPrivateStorage.js";
let privateOverride;
let privateCached;
/** Tests swap in a fake. */
export function setPrivateStorage(storage) {
    privateOverride = storage;
}
export function getPrivateStorage() {
    if (privateOverride)
        return privateOverride;
    if (privateCached)
        return privateCached;
    if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
        privateCached = new CloudinaryPrivateStorage({ cloudName: env.CLOUDINARY_CLOUD_NAME, apiKey: env.CLOUDINARY_API_KEY, apiSecret: env.CLOUDINARY_API_SECRET });
    }
    else if (!isProd) {
        privateCached = new LocalPrivateStorage();
    }
    else {
        throw AppError.unavailable("File storage is not configured");
    }
    return privateCached;
}
