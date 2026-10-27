import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
// Deliberately NOT under server/uploads, which is served publicly in development.
export const PRIVATE_ROOT = path.resolve(process.cwd(), "uploads-private");
/** Development and test fallback when Cloudinary is not configured. Files are never exposed by URL. */
export class LocalPrivateStorage {
    root;
    constructor(root = PRIVATE_ROOT) {
        this.root = root;
    }
    async put(buffer, { folder, ext }) {
        const publicId = `${folder}/${randomUUID()}.${ext}`;
        const target = this.resolve(publicId);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, buffer);
        return { publicId };
    }
    async open(publicId, mime) {
        return { kind: "buffer", data: await fs.readFile(this.resolve(publicId)), mime };
    }
    async remove(publicId) {
        await fs.rm(this.resolve(publicId), { force: true });
    }
    /** Resolves inside the root only, so a crafted publicId cannot escape it. */
    resolve(publicId) {
        const target = path.resolve(this.root, publicId);
        if (!target.startsWith(this.root + path.sep))
            throw new Error("Invalid storage path");
        return target;
    }
}
