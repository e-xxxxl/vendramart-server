import { User } from "../models/User.js";
import { hashPassword } from "../modules/auth/auth.service.js";

/** Creates the Super Admin, or resets the password if that admin already exists. Refuses to touch a non-admin account. */
export async function ensureAdmin(opts: { email: string; password: string; name?: string }): Promise<"created" | "reset"> {
  const { password } = opts;
  const email = opts.email.toLowerCase();
  if (password.length < 8) throw new Error("SEED_ADMIN_PASSWORD must be at least 8 characters");

  const passwordHash = await hashPassword(password);
  const existing = await User.findOne({ email });
  if (existing) {
    if (existing.role !== "ADMIN") throw new Error(`${email} exists with role ${existing.role}; refusing to change it`);
    existing.passwordHash = passwordHash;
    await existing.save();
    return "reset";
  }
  await User.create({ role: "ADMIN", name: opts.name ?? "VendraMart Admin", email, phone: "08000000000", passwordHash });
  return "created";
}
