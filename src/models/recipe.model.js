import mongoose from "mongoose";

const USER_TYPES = ["normal_user", "premium_user"];
const RECIPE_STATUSES = ["draft", "published", "archived"];
const RECIPE_TYPES = ["breakfast", "lunch", "dinner", "snack", "meal", "other"];

const mediaAssetSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true },
    publicId: { type: String, default: "", trim: true },
    mimetype: { type: String, default: "", trim: true },
    size: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const recipeSchema = new mongoose.Schema(
  {
    recipeName: {
      type: String,
      required: [true, "Recipe name is required"],
      trim: true,
      maxlength: [120, "Recipe name should not exceed 120 characters"],
    },
    recipeDuration: {
      type: String,
      required: [true, "Recipe duration is required"],
      trim: true,
      maxlength: [60, "Recipe duration should not exceed 60 characters"],
    },
    durationMinutes: {
      type: Number,
      required: [true, "durationMinutes is required"],
      min: [1, "durationMinutes must be at least 1 minute"],
      max: [480, "durationMinutes should not exceed 480 minutes"],
    },
    recipeType: {
      type: String,
      enum: RECIPE_TYPES,
      required: [true, "recipeType is required"],
      default: "breakfast",
      index: true,
    },
    userType: {
      type: String,
      enum: USER_TYPES,
      required: [true, "userType is required"],
      default: "normal_user",
      index: true,
    },
    assignedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    howToPrepare: {
      type: String,
      default: "",
      trim: true,
      maxlength: [6000, "How to prepare should not exceed 6000 characters"],
    },
    ingredients: {
      type: [String],
      default: [],
    },
    caloriesKcal: {
      type: Number,
      min: 0,
      default: 0,
    },
    proteinG: {
      type: Number,
      min: 0,
      default: 0,
    },
    carbsG: {
      type: Number,
      min: 0,
      default: 0,
    },
    fatG: {
      type: Number,
      min: 0,
      default: 0,
    },
    recipeImages: {
      type: [mediaAssetSchema],
      default: [],
    },
    status: {
      type: String,
      enum: RECIPE_STATUSES,
      default: "published",
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
      index: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

recipeSchema.pre("validate", function preValidate(next) {
  this.ingredients = (this.ingredients || [])
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);

  if (this.userType === "normal_user") {
    this.assignedUser = null;
  }

  // premium_user recipes without an assignedUser are private admin-only
  // library recipes: never visible to regular users, assignable later.

  if (!Array.isArray(this.recipeImages) || this.recipeImages.length === 0) {
    return next(new Error("At least one recipe image is required."));
  }

  next();
});

recipeSchema.index({ status: 1, isActive: 1, userType: 1, recipeType: 1, createdAt: -1 });
recipeSchema.index({ assignedUser: 1, status: 1, isActive: 1, createdAt: -1 });

export const Recipe = mongoose.model("Recipe", recipeSchema);
