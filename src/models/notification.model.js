import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: [120, "Notification title should not exceed 120 characters"],
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: [300, "Notification message should not exceed 300 characters"],
    },
    type: {
      type: String,
      enum: ["streak", "workout", "nutrition", "achievement", "summary", "general"],
      default: "general",
      index: true,
    },
    readAt: {
      type: Date,
      default: null,
      index: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, createdAt: -1 });

export const Notification = mongoose.model("Notification", notificationSchema);
