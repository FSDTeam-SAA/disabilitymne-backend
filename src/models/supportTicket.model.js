import mongoose from "mongoose";

const supportTicketSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: [160, "Email should not exceed 160 characters"],
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: [120, "Subject should not exceed 120 characters"],
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: [300, "Description should not exceed 300 characters"],
    },
    status: {
      type: String,
      enum: ["open", "in_progress", "resolved", "closed"],
      default: "open",
      index: true,
    },
    adminResponse: {
      type: String,
      default: "",
      trim: true,
      maxlength: [1000, "Admin response should not exceed 1000 characters"],
    },
    resolvedAt: Date,
  },
  { timestamps: true }
);

supportTicketSchema.index({ user: 1, createdAt: -1 });

export const SupportTicket = mongoose.model("SupportTicket", supportTicketSchema);
