import { Schema, model } from "mongoose";
export const ROLES = ["CUSTOMER", "VENDOR", "ADMIN", "HANDLER"];
const userSchema = new Schema({
    role: { type: String, enum: ROLES, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    lastLoginAt: { type: Date },
}, { timestamps: true });
export const User = model("User", userSchema);
export function publicUser(u) {
    return { id: String(u._id), role: u.role, name: u.name, email: u.email, phone: u.phone };
}
