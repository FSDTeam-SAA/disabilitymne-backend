import mongoose from "mongoose";

const mediaAssetSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true },
    publicId: { type: String, default: "", trim: true },
    mimetype: { type: String, default: "", trim: true },
    size: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const chatMessageSchema = new mongoose.Schema(
  {
    thread: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChatThread",
      required: true,
      index: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    message: {
      type: String,
      default: "",
      trim: true,
      maxlength: [2000, "Message should not exceed 2000 characters"],
    },
    attachments: {
      type: [mediaAssetSchema],
      default: [],
    },
    readAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

chatMessageSchema.pre("validate", function preValidate(next) {
  this.message = typeof this.message === "string" ? this.message.trim() : "";
  this.attachments = Array.isArray(this.attachments) ? this.attachments.filter((item) => item && item.url) : [];

  if (!this.message && this.attachments.length === 0) {
    return next(new Error("Either message text or at least one attachment is required."));
  }

  next();
});

chatMessageSchema.index({ thread: 1, createdAt: 1 });
chatMessageSchema.index({ recipient: 1, readAt: 1, createdAt: -1 });

export const ChatMessage = mongoose.model("ChatMessage", chatMessageSchema);
