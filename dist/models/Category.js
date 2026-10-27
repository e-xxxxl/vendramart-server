import { Schema, model } from "mongoose";
import { categoryImage } from "../config/placeholderImages.js";
const categorySchema = new Schema({
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    sortOrder: { type: Number, default: 0 },
    image: { type: String },
}, { timestamps: true });
export const Category = model("Category", categorySchema);
export const publicCategory = (c) => ({
    id: String(c._id),
    name: c.name,
    slug: c.slug,
    image: categoryImage(c.slug, c.image),
});
