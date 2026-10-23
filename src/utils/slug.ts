import type { Model } from "mongoose";
import { slugify } from "../seed/reference.js";

/** Returns `base`, or `base-2`, `base-3`... whichever is free in the given collection. */
export async function uniqueSlug(model: Model<any>, text: string): Promise<string> {
  const base = slugify(text) || "item";
  let candidate = base;
  for (let n = 2; await model.exists({ slug: candidate }); n++) candidate = `${base}-${n}`;
  return candidate;
}
