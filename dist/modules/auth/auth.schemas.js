import { z } from "zod";
import { email, password, phone } from "../../utils/zodCommon.js";
export const addressInput = z.object({
    label: z.string().trim().min(1).max(40).default("Home"),
    line: z.string().trim().min(5, "Enter your delivery address").max(300),
    landmark: z.string().trim().max(200).optional(),
    placeId: z.string().trim().max(300).optional(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
});
export const registerCustomerSchema = z.object({
    name: z.string().trim().min(2, "Enter your full name").max(120),
    email,
    phone,
    password,
    address: addressInput,
});
export const loginSchema = z.object({
    email,
    password: z.string().min(1, "Enter your password").max(72),
});
