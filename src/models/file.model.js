import mongoose from "mongoose";

const fileSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String, default: "" },
    mimetype: { type: String, default: "" },
    size: { type: Number, default: 0 },
    folder: { type: String, default: "uploads" },
  },
  { timestamps: true }
);

export const File = mongoose.model("File", fileSchema);
