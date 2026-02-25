import mongoose from "mongoose";
import { PLAN_KEYS } from "../constants/subscriptionPlans.js";

const paymentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    planKey: {
      type: String,
      enum: PLAN_KEYS,
      required: true,
    },
    planName: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      required: true,
      default: "USD",
      uppercase: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["pending", "succeeded", "failed", "refunded"],
      default: "pending",
      index: true,
    },
    paymentMethod: {
      type: String,
      enum: ["card", "bank_account", "manual"],
      required: true,
    },
    provider: {
      type: String,
      default: "mock_gateway",
      trim: true,
    },
    transactionId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    cardLast4: {
      type: String,
      default: "",
      trim: true,
      maxlength: 4,
    },
    cardBrand: {
      type: String,
      default: "",
      trim: true,
      maxlength: 24,
    },
    paidAt: Date,
    failureReason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 180,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

export const Payment = mongoose.model("Payment", paymentSchema);
