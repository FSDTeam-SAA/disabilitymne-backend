import mongoose from "mongoose";

const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack", "other"];
const ENTRY_SOURCES = ["manual", "usda"];

const nutritionEntrySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    entryDate: {
      type: Date,
      required: true,
      index: true,
    },
    mealType: {
      type: String,
      enum: MEAL_TYPES,
      required: true,
      default: "breakfast",
      index: true,
    },
    foodName: {
      type: String,
      required: true,
      trim: true,
      maxlength: [160, "Food name should not exceed 160 characters"],
    },
    brandName: {
      type: String,
      default: "",
      trim: true,
      maxlength: [120, "Brand name should not exceed 120 characters"],
    },
    source: {
      type: String,
      enum: ENTRY_SOURCES,
      default: "manual",
    },
    fdcId: {
      type: Number,
      default: null,
      min: 1,
      index: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: [0.01, "Quantity must be greater than 0"],
    },
    servingLabel: {
      type: String,
      required: true,
      trim: true,
      maxlength: [60, "Serving label should not exceed 60 characters"],
      default: "gram",
    },
    totalGrams: {
      type: Number,
      default: 0,
      min: [0, "totalGrams cannot be negative"],
    },
    caloriesKcal: {
      type: Number,
      default: 0,
      min: 0,
    },
    proteinG: {
      type: Number,
      default: 0,
      min: 0,
    },
    carbsG: {
      type: Number,
      default: 0,
      min: 0,
    },
    fatG: {
      type: Number,
      default: 0,
      min: 0,
    },
    fiberG: {
      type: Number,
      default: 0,
      min: 0,
    },
    sugarG: {
      type: Number,
      default: 0,
      min: 0,
    },
    imageUrl: {
      type: String,
      default: "",
      trim: true,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
      maxlength: [500, "Notes should not exceed 500 characters"],
    },
    isFavorite: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
);

nutritionEntrySchema.pre("validate", function preValidate(next) {
  if (this.entryDate) {
    const entryDate = new Date(this.entryDate);
    entryDate.setHours(0, 0, 0, 0);
    this.entryDate = entryDate;
  }

  next();
});

nutritionEntrySchema.index({ user: 1, entryDate: 1, mealType: 1, createdAt: -1 });
nutritionEntrySchema.index({ user: 1, isFavorite: 1, updatedAt: -1 });

export const NutritionEntry = mongoose.model("NutritionEntry", nutritionEntrySchema);
