import { v2 as cloudinary } from "cloudinary";
export class CloudinaryStorage {
    constructor(cfg) {
        cloudinary.config({ cloud_name: cfg.cloudName, api_key: cfg.apiKey, api_secret: cfg.apiSecret, secure: true });
    }
    upload(buffer, { folder }) {
        return new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream({
                folder,
                resource_type: "image",
                // Re-encode to a sane size so a 12 MB phone photo does not hit the storefront.
                transformation: [{ width: 1600, height: 1600, crop: "limit", quality: "auto", fetch_format: "auto" }],
            }, (err, result) => {
                if (err || !result)
                    return reject(err ?? new Error("Cloudinary returned no result"));
                resolve({ url: result.secure_url, publicId: result.public_id });
            });
            stream.end(buffer);
        });
    }
    async remove(publicId) {
        await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
    }
}
