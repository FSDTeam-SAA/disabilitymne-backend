import mongoose from "mongoose";

const DEFAULT_MAX_PREMIUM_USERS = 20;

const appSettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: "global",
      trim: true,
    },
    maxPremiumUsers: {
      type: Number,
      required: true,
      min: [0, "maxPremiumUsers cannot be negative"],
      default: DEFAULT_MAX_PREMIUM_USERS,
    },
  },
  { timestamps: true }
);

export const AppSettings = mongoose.model("AppSettings", appSettingsSchema);
export { DEFAULT_MAX_PREMIUM_USERS };
