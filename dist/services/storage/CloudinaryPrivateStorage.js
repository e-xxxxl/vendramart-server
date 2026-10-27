import { v2 as cloudinary } from "cloudinary";
/**
 * Cloudinary "authenticated" assets: they cannot be fetched at a plain URL, only through a link signed with our
 * API secret. We only hand that link to someone our own route has already authorised (the owning vendor or an admin).
 * Note: on standard plans the signed link does not expire by itself; the protection is that it is unguessable
 * and is only ever issued after the access check.
 */
export class CloudinaryPrivateStorage {
    constructor(cfg) {
        cloudinary.config({ cloud_name: cfg.cloudName, api_key: cfg.apiKey, api_secret: cfg.apiSecret, secure: true });
    }
    put(buffer, { folder }) {
        return new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream({ folder, resource_type: "auto", type: "authenticated" }, (err, result) => {
                if (err || !result)
                    return reject(err ?? new Error("Cloudinary returned no result"));
                resolve({ publicId: result.public_id, resourceType: result.resource_type });
            });
            stream.end(buffer);
        });
    }
    async open(publicId, mime, resourceType = "image") {
        const format = mime === "application/pdf" ? "pdf" : undefined;
        const url = cloudinary.url(publicId, { resource_type: resourceType, type: "authenticated", sign_url: true, secure: true, format });
        return { kind: "redirect", url };
    }
    async remove(publicId, resourceType = "image") {
        await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, type: "authenticated" });
    }
}
