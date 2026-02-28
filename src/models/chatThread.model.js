import mongoose from "mongoose";

const chatThreadSchema = new mongoose.Schema(
  {
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    premiumUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    lastMessagePreview: {
      type: String,
      default: "",
      trim: true,
      maxlength: [500, "lastMessagePreview should not exceed 500 characters"],
    },
    lastMessageAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

chatThreadSchema.index({ admin: 1, premiumUser: 1 }, { unique: true });
chatThreadSchema.index({ premiumUser: 1, lastMessageAt: -1 });
chatThreadSchema.index({ admin: 1, lastMessageAt: -1 });

export const ChatThread = mongoose.model("ChatThread", chatThreadSchema);
