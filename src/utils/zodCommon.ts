import { z } from "zod";

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");

export const email = z.string().trim().toLowerCase().email("Enter a valid email address").max(160);

// Nigerian mobile numbers: 0803..., +234803..., 234803...
export const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s()-]/g, ""))
  .refine((v) => /^(\+?234|0)[789][01]\d{8}$/.test(v), "Enter a valid Nigerian phone number");

export const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password is too long")
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), "Password needs at least one letter and one number");

export const latLng = {
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
};

/** Whole kobo. Rejects decimals so a float can never reach money math. */
export const kobo = z.number().int("Amount must be a whole number of kobo").min(0);

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(12),
});

/** Escapes user text for safe use inside a RegExp. */
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
