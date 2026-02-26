import mongoose from "mongoose";

const subscriptionPlanSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: [80, "Plan name should not exceed 80 characters"],
    },
    price: {
      type: Number,
      required: true,
      min: [0, "Plan price cannot be negative"],
    },
    currency: {
      type: String,
      required: true,
      default: "USD",
      uppercase: true,
      trim: true,
      maxlength: 8,
    },
    durationLabel: {
      type: String,
      required: true,
      trim: true,
      maxlength: [40, "Duration label should not exceed 40 characters"],
    },
    durationMonths: {
      type: Number,
      default: 0,
      min: 0,
      max: 120,
    },
    trialDays: {
      type: Number,
      default: 0,
      min: 0,
      max: 365,
    },
    features: {
      type: [String],
      default: [],
    },
    isPopular: {
      type: Boolean,
      default: false,
    },
    sortOrder: {
      type: Number,
      default: 0,
      min: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    deletedAt: Date,
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

subscriptionPlanSchema.index({ isActive: 1, sortOrder: 1, createdAt: 1 });

export const SubscriptionPlan = mongoose.model("SubscriptionPlan", subscriptionPlanSchema);
