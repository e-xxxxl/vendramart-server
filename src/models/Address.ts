import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

const addressSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    label: { type: String, default: "Home", trim: true, maxlength: 40 },
    line: { type: String, required: true, trim: true, maxlength: 300 },
    landmark: { type: String, trim: true, maxlength: 200 },
    placeId: { type: String, trim: true },
    location: {
      lat: { type: Number, required: true, min: -90, max: 90 },
      lng: { type: Number, required: true, min: -180, max: 180 },
    },
    // Resolved from the city radius check; wired up in Phase 2 when cities exist.
    cityId: { type: Schema.Types.ObjectId, ref: "City" },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export type AddressAttrs = InferSchemaType<typeof addressSchema>;
export type AddressDoc = HydratedDocument<AddressAttrs>;
export const Address = model("Address", addressSchema);

export function publicAddress(a: AddressDoc) {
  return {
    id: String(a._id),
    label: a.label,
    line: a.line,
    landmark: a.landmark ?? null,
    placeId: a.placeId ?? null,
    lat: a.location!.lat,
    lng: a.location!.lng,
    cityId: a.cityId ? String(a.cityId) : null,
    isDefault: a.isDefault,
  };
}
