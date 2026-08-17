import mongoose from "mongoose";

const homeBannerImageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true },
    publicId: { type: String, default: "", trim: true },
    mimetype: { type: String, default: "", trim: true },
    size: { type: Number, default: 0 },
  },
  { _id: false }
);

const homeBannerSchema = new mongoose.Schema(
  {
    image: {
      type: homeBannerImageSchema,
      required: true,
    },
    sortOrder: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

homeBannerSchema.index({ sortOrder: 1, createdAt: 1 });
homeBannerSchema.index({ isActive: 1, sortOrder: 1 });

export const HomeBanner = mongoose.model("HomeBanner", homeBannerSchema);
