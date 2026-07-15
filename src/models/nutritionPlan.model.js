import mongoose from "mongoose";

const NUTRITION_DAY_INDEXES = [1, 2, 3, 4, 5, 6, 7];
const PLAN_STATUSES = ["draft", "published", "archived"];
const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack", "meal", "other"];

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
      required: [true, "assignedUser is required"],
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
        label: String(day.label || "").trim(),
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
nutritionPlanSchema.index({ "nutritionDays.dayIndex": 1, status: 1, isActive: 1 });

export const NutritionPlan = mongoose.model("NutritionPlan", nutritionPlanSchema);
export { NUTRITION_DAY_INDEXES, PLAN_STATUSES, MEAL_TYPES };
