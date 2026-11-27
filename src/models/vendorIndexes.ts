import { Vendor } from "./Vendor.js";

/**
 * A store used to be one per sign-in and one per NIN, so a database made before now has UNIQUE indexes on `userId` and `nin`.
 * Mongo keeps an old index even when the schema stops asking for it, and it would still refuse a second store. This drops those
 * two old unique indexes (and only those: a plain index with the same name is left alone) and builds the plain ones.
 * Safe to run on every start.
 */
export async function migrateVendorIndexes(): Promise<string[]> {
  const dropped: string[] = [];
  let existing: { name?: string; unique?: boolean }[] = [];
  try {
    existing = await Vendor.collection.indexes();
  } catch {
    // The collection does not exist yet: a new database is created with the right indexes below.
  }
  for (const idx of existing) {
    if (idx.unique && (idx.name === "userId_1" || idx.name === "nin_1")) {
      await Vendor.collection.dropIndex(idx.name);
      dropped.push(idx.name);
    }
  }
  await Vendor.init();
  return dropped;
}
