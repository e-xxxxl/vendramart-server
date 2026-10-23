import { Schema, model } from "mongoose";
import { ORDER_STATUSES } from "../domain/orderStateMachine.js";

// Append-only history: every status change, who made it and when.
const statusLogSchema = new Schema({
  subOrderId: { type: Schema.Types.ObjectId, ref: "SubOrder", required: true, index: true },
  orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
  from: { type: String, enum: [...ORDER_STATUSES, null], default: null },
  to: { type: String, enum: ORDER_STATUSES, required: true },
  actorId: { type: Schema.Types.ObjectId, ref: "User" },
  actorRole: { type: String, enum: ["SYSTEM", "CUSTOMER", "VENDOR", "ADMIN", "HANDLER"], required: true },
  note: String,
  at: { type: Date, default: Date.now, index: true },
});

export const StatusLog = model("StatusLog", statusLogSchema);
