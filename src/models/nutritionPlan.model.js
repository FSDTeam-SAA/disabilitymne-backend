import mongoose from "mongoose";

const NUTRITION_DAY_INDEXES = [1, 2, 3, 4, 5, 6, 7];
const PLAN_STATUSES = ["draft", "published", "archived"];
/** Supports classic meal types plus structured Meal 1–3 / Snack 1–3 slots */
const MEAL_TYPES = [
  "breakfast",
  "lunch",
  "dinner",
  "snack",
  "meal",
  "other",
  "meal_1",
  "snack_1",
  "meal_2",
  "snack_2",
  "meal_3",
  "snack_3",
];
const WEEKDAY_FULL_LABELS = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};
const DEFAULT_DAY_SLOT_ORDER = [
  "meal_1",
  "snack_1",
  "meal_2",
  "snack_2",
  "meal_3",
  "snack_3",
];

const mealSlotSchema = new mongoose.Schema(
  {
    recipe: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Recipe",
      required: true,
    },
    mealType: {
      type: String,
      enum: MEAL_TYPES,
      default: "meal",
    },
    order: {
      type: Number,
      min: 1,
      default: 1,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
      maxlength: [500, "Meal notes should not exceed 500 characters"],
    },
  },
  { _id: true }
);

const nutritionDaySchema = new mongoose.Schema(
  {
    dayIndex: {
      type: Number,
      required: true,
      enum: NUTRITION_DAY_INDEXES,
    },
    label: {
      type: String,
      default: "",
      trim: true,
      maxlength: [40, "Day label should not exceed 40 characters"],
    },
    meals: {
      type: [mealSlotSchema],
      default: [],
    },
  },
  { _id: false }
);

const nutritionPlanSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Nutrition plan title is required"],
      trim: true,
      maxlength: [120, "Title should not exceed 120 characters"],
    },
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: [4000, "Description should not exceed 4000 characters"],
    },
    assignedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    /** Reusable meal program library template */
    isTemplate: {
      type: Boolean,
      default: false,
      index: true,
    },
    sourceTemplate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "NutritionPlan",
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: PLAN_STATUSES,
      default: "published",
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    nutritionDays: {
      type: [nutritionDaySchema],
      default: [],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

nutritionPlanSchema.pre("validate", function normalizeDays(next) {
  this.nutritionDays = Array.isArray(this.nutritionDays) ? this.nutritionDays : [];

  if (this.isTemplate) {
    this.assignedUser = null;
  } else if (!this.assignedUser) {
    return next(new Error("assignedUser is required for nutrition plans (or set isTemplate=true)."));
  }

  const seen = new Set();
  this.nutritionDays = this.nutritionDays
    .filter((day) => day && NUTRITION_DAY_INDEXES.includes(Number(day.dayIndex)))
    .map((day) => {
      const dayIndex = Number(day.dayIndex);
      const meals = Array.isArray(day.meals)
        ? day.meals
            .filter((meal) => meal && meal.recipe)
            .map((meal, index) => ({
              recipe: meal.recipe,
              mealType: MEAL_TYPES.includes(meal.mealType) ? meal.mealType : "meal",
              order: Number(meal.order) > 0 ? Number(meal.order) : index + 1,
              notes: String(meal.notes || "").trim(),
            }))
        : [];

      return {
        dayIndex,
        label: String(day.label || "").trim() || WEEKDAY_FULL_LABELS[dayIndex] || "",
        meals,
      };
    })
    .filter((day) => {
      if (seen.has(day.dayIndex)) return false;
      seen.add(day.dayIndex);
      return true;
    })
    .sort((a, b) => a.dayIndex - b.dayIndex);

  next();
});

nutritionPlanSchema.index({ assignedUser: 1, status: 1, isActive: 1, createdAt: -1 });
nutritionPlanSchema.index({ isTemplate: 1, status: 1, isActive: 1, createdAt: -1 });
nutritionPlanSchema.index({ "nutritionDays.dayIndex": 1, status: 1, isActive: 1 });

export const NutritionPlan = mongoose.model("NutritionPlan", nutritionPlanSchema);
export {
  NUTRITION_DAY_INDEXES,
  PLAN_STATUSES,
  MEAL_TYPES,
  WEEKDAY_FULL_LABELS,
  DEFAULT_DAY_SLOT_ORDER,
};
