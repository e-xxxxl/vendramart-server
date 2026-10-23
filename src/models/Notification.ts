import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, required: true }, // e.g. ORDER_PAID, READY_FOR_PICKUP, DELIVERED
    title: { type: String, required: true, maxlength: 140 },
    body: { type: String, required: true, maxlength: 400 },
    link: { type: String, maxlength: 300 }, // app path, e.g. /vendor/orders
    readAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });

export type NotificationAttrs = InferSchemaType<typeof notificationSchema>;
export type NotificationDoc = HydratedDocument<NotificationAttrs>;
export const Notification = model("Notification", notificationSchema);

export const publicNotification = (n: NotificationDoc) => ({
  id: String(n._id),
  kind: n.kind,
  title: n.title,
  body: n.body,
  link: n.link ?? null,
  read: Boolean(n.readAt),
  createdAt: n.createdAt,
});
