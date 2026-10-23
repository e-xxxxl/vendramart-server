export interface StoredImage {
  url: string;
  /** Opaque id used to delete the image later. Starts with the folder it was stored in. */
  publicId: string;
}

export interface UploadOptions {
  /** e.g. `vendors/<vendorId>/products`. Used for ownership checks. */
  folder: string;
}

/** Anything that can hold uploaded images. Cloudinary in production, local disk for dev and tests. */
export interface ImageStorage {
  upload(buffer: Buffer, options: UploadOptions): Promise<StoredImage>;
  remove(publicId: string): Promise<void>;
}
