import mongoose from "mongoose";

const SUBSCRIPTION_STATUSES = ["none", "trial", "pending_payment", "active", "expired", "cancelled"];
const CHANGE_REASONS = [
  "purchase",
  "renewal",
  "admin_grant",
  "admin_revoke",
  "expiry",
  "cancellation",
  "plan_change",
  "sync",
  "restore",
];

const subscriptionHistorySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    planKey: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    previousStatus: {
      type: String,
      enum: SUBSCRIPTION_STATUSES,
      default: "none",
    },
    newStatus: {
      type: String,
      enum: SUBSCRIPTION_STATUSES,
      required: true,
      index: true,
    },
    previousPlanKey: {
      type: String,
      default: "",
      trim: true,
    },
    subscriptionStartedAt: { type: Date, default: null },
    subscriptionEndsAt: { type: Date, default: null },
    reason: {
      type: String,
      enum: CHANGE_REASONS,
      default: "sync",
      index: true,
    },
    note: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

subscriptionHistorySchema.index({ user: 1, createdAt: -1 });
subscriptionHistorySchema.index({ newStatus: 1, createdAt: -1 });

export const SubscriptionHistory = mongoose.model("SubscriptionHistory", subscriptionHistorySchema);
export { SUBSCRIPTION_STATUSES, CHANGE_REASONS };
