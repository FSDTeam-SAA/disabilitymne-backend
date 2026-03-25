import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { NutritionEntry } from "../models/nutritionEntry.model.js";
import { Recipe } from "../models/recipe.model.js";
import { WorkoutLog } from "../models/workoutLog.model.js";
import { isPremiumActiveUser } from "../utils/access.js";

const USDA_API_BASE = "https://api.nal.usda.gov/fdc/v1";
const USDA_API_KEY =
  process.env.USDA_API_KEY ||
  "VX7AHDHEBkC30WvicvVaaWFPhstMwb7nmFczm6Br";

const GOAL_KCAL_RANGE = {
  fat_loss: { min: 22, max: 26 },
  maintenance: { min: 28, max: 33 },
  muscle_gain: { min: 34, max: 40 },
};

const DEFAULT_MACRO_PER_KG = {
  protein: 1.8,
  carbs: 2,
  fat: 0.8,
};

const NUTRIENT_KEYS = {
  caloriesKcal: ["1008", "208", "Energy"],
  proteinG: ["1003", "203", "Protein"],
  carbsG: ["1005", "205", "Carbohydrate"],
  fatG: ["1004", "204", "Total lipid (fat)"],
  fiberG: ["1079", "291", "Fiber, total dietary"],
  sugarG: ["2000", "269", "Total Sugars"],
};

const DIARY_MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack", "other"];
const DIARY_MEAL_TYPE_SET = new Set(DIARY_MEAL_TYPES);
const DIARY_MEAL_LABELS = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
  other: "Other",
};
const DIARY_SOURCE_SET = new Set(["manual", "usda"]);
const MEAL_KCAL_DISTRIBUTION = {
  breakfast: { min: 0.2, max: 0.3 },
  lunch: { min: 0.25, max: 0.35 },
  dinner: { min: 0.3, max: 0.4 },
  snack: { min: 0.1, max: 0.2 },
  other: { min: 0, max: 0.1 },
};

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const toMealLabel = (mealType) => {
  const normalized = asString(mealType).toLowerCase();
  if (DIARY_MEAL_LABELS[normalized]) {
    return DIARY_MEAL_LABELS[normalized];
  }

  if (!normalized) {
    return "Meal";
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
};

const round = (value, decimals = 1) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

const parseNumber = (value, fieldName, min = 0, required = false) => {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new AppError(`${fieldName} is required.`, httpStatus.BAD_REQUEST);
    }
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new AppError(`${fieldName} must be a number >= ${min}.`, httpStatus.BAD_REQUEST);
  }

  return parsed;
};

const parseBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
};

const parseGoal = (value) => {
  const goal = asString(value).toLowerCase().replace(/\s+/g, "_");
  if (!goal) return "maintenance";

  if (goal === "fat_loss" || goal === "maintenance" || goal === "muscle_gain") {
    return goal;
  }

  throw new AppError("goal must be one of: fat_loss, maintenance, muscle_gain.", httpStatus.BAD_REQUEST);
};

const toKg = (measurement) => {
  if (!measurement || typeof measurement.value !== "number") return null;
  if (measurement.unit === "kg") return measurement.value;
  if (measurement.unit === "lbs") return measurement.value * 0.453592;
  return null;
};

const resolveWeightKgFromSource = (source, user, required = true) => {
  const weightKgInput = parseNumber(source.weightKg, "weightKg", 1, false);
  if (weightKgInput !== undefined) return weightKgInput;

  const useGoalWeight = parseBoolean(source.useGoalWeight, false);
  const profileWeight = useGoalWeight ? toKg(user?.goalWeight) : toKg(user?.weightCurrent);

  if (profileWeight && profileWeight > 0) {
    return profileWeight;
  }

  if (!required) {
    return null;
  }

  throw new AppError(
    "weightKg is required (or set profile weight and retry).",
    httpStatus.BAD_REQUEST
  );
};

const findNutrientValue = (foodNutrients, aliases) => {
  if (!Array.isArray(foodNutrients)) return null;

  const aliasSet = new Set(aliases.map((alias) => String(alias).toLowerCase()));
  for (const nutrient of foodNutrients) {
    const nutrientId = String(nutrient.nutrientId || nutrient.nutrient?.id || "").toLowerCase();
    const nutrientNumber = String(nutrient.nutrientNumber || nutrient.nutrient?.number || "").toLowerCase();
    const nutrientName = String(nutrient.nutrientName || nutrient.nutrient?.name || "").toLowerCase();
    if (aliasSet.has(nutrientId) || aliasSet.has(nutrientNumber) || aliasSet.has(nutrientName)) {
      const value = Number(nutrient.value ?? nutrient.amount);
      if (Number.isFinite(value)) return value;
    }
  }

  return null;
};

const toFiniteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toPortionLabel = (portion = {}) => {
  const amount = toFiniteNumber(portion.amount);
  const measureUnit = asString(portion.measureUnit?.name || portion.measureUnit?.abbreviation || portion.measureUnitName);
  const modifier = asString(portion.modifier || portion.portionDescription);
  const parts = [];

  if (amount && amount !== 1) {
    parts.push(String(amount));
  }
  if (measureUnit) {
    parts.push(measureUnit);
  }
  if (modifier) {
    parts.push(modifier);
  }

  return parts.join(" ").trim() || "Serving";
};

const convertToGrams = (value, unit) => {
  const amount = toFiniteNumber(value);
  if (!amount || amount <= 0) return null;

  const normalized = asString(unit).toLowerCase();
  if (["g", "gram", "grams"].includes(normalized)) return amount;
  if (["oz", "onz", "ounce", "ounces"].includes(normalized)) return amount * 28.3495;
  if (["ml", "milliliter", "milliliters"].includes(normalized)) return amount;

  return null;
};

const upsertPortionOption = (list, option) => {
  if (!option || !option.label || !Number.isFinite(Number(option.gramWeight))) return;
  const gramWeight = round(Number(option.gramWeight), 1);
  if (gramWeight <= 0) return;

  const key = `${option.label.toLowerCase()}|${gramWeight}`;
  if (list.some((item) => `${item.label.toLowerCase()}|${item.gramWeight}` === key)) return;

  list.push({
    id: option.id ?? null,
    label: option.label,
    amount: Number.isFinite(Number(option.amount)) ? Number(option.amount) : 1,
    gramWeight,
    estimated: Boolean(option.estimated),
  });
};

const mapFoodPortions = (food = {}) => {
  const portions = Array.isArray(food.foodPortions) ? food.foodPortions : [];
  const mapped = portions.reduce((acc, portion) => {
      const gramWeight = toFiniteNumber(portion.gramWeight);
      if (!gramWeight || gramWeight <= 0) {
        return acc;
      }

      acc.push({
        id: portion.id ?? null,
        label: toPortionLabel(portion),
        amount: toFiniteNumber(portion.amount) || 1,
        gramWeight: round(gramWeight, 1),
      });

      return acc;
    }, []);

  const servingGramWeight = convertToGrams(food.servingSize, food.servingSizeUnit);
  if (servingGramWeight) {
    const householdLabel = asString(food.householdServingFullText);
    const servingLabel = householdLabel ? `Serving (${householdLabel})` : "Serving";
    upsertPortionOption(mapped, {
      label: servingLabel,
      gramWeight: servingGramWeight,
      amount: 1,
    });
    upsertPortionOption(mapped, {
      label: "Half serving",
      gramWeight: servingGramWeight / 2,
      amount: 0.5,
    });
  }

  const householdText = asString(food.householdServingFullText);
  const householdMatch = householdText.match(/([0-9]+(?:\\.[0-9]+)?)\\s*(oz|onz|ounce|ounces)\\b/i);
  if (!servingGramWeight && householdMatch) {
    const gramsFromOz = convertToGrams(Number(householdMatch[1]), householdMatch[2]);
    if (gramsFromOz) {
      upsertPortionOption(mapped, {
        label: `Serving (${householdText})`,
        gramWeight: gramsFromOz,
        amount: 1,
      });
    }
  }

  const descriptor = `${asString(food.description)} ${asString(
    typeof food.foodCategory === "string" ? food.foodCategory : food.foodCategory?.description || food.brandedFoodCategory
  )}`.toLowerCase();

  if (servingGramWeight && /\b(apple|banana|orange|pear|peach|mango|avocado)\b/.test(descriptor)) {
    upsertPortionOption(mapped, {
      label: "Whole",
      gramWeight: servingGramWeight,
      estimated: true,
    });
    upsertPortionOption(mapped, {
      label: "Half",
      gramWeight: servingGramWeight / 2,
      amount: 0.5,
      estimated: true,
    });
    upsertPortionOption(mapped, {
      label: "Slice",
      gramWeight: servingGramWeight / 10,
      estimated: true,
    });
  }

  if (/\b(spread|peanut butter|butter|sauce|syrup|honey|oil)\b/.test(descriptor)) {
    upsertPortionOption(mapped, {
      label: "Tablespoon",
      gramWeight: 15,
      estimated: true,
    });
    upsertPortionOption(mapped, {
      label: "Teaspoon",
      gramWeight: 5,
      estimated: true,
    });
  }

  const result = [];
  for (const portion of mapped) {
    upsertPortionOption(result, portion);
  }

  if (!result.some((portion) => portion.label.toLowerCase() === "gram" && portion.gramWeight === 1)) {
    result.push({
      id: null,
      label: "Gram",
      amount: 1,
      gramWeight: 1,
      estimated: false,
    });
  }

  return result.slice(0, 30);
};

const mapFoodSummary = (food) => {
  const foodNutrients = Array.isArray(food.foodNutrients) ? food.foodNutrients : [];
  const nutrients = {
    caloriesKcal: findNutrientValue(foodNutrients, NUTRIENT_KEYS.caloriesKcal),
    proteinG: findNutrientValue(foodNutrients, NUTRIENT_KEYS.proteinG),
    carbsG: findNutrientValue(foodNutrients, NUTRIENT_KEYS.carbsG),
    fatG: findNutrientValue(foodNutrients, NUTRIENT_KEYS.fatG),
    fiberG: findNutrientValue(foodNutrients, NUTRIENT_KEYS.fiberG),
    sugarG: findNutrientValue(foodNutrients, NUTRIENT_KEYS.sugarG),
  };
  const portionOptions = mapFoodPortions(food);
  const defaultPortionOption =
    portionOptions.find((portion) => /whole|serving/i.test(asString(portion.label))) ||
    portionOptions.find((portion) => asString(portion.label).toLowerCase() === "gram") ||
    portionOptions[0] ||
    null;
  const defaultPortionFactor = defaultPortionOption ? Number(defaultPortionOption.gramWeight || 0) / 100 : 0;
  const display = {
    caloriesKcal:
      defaultPortionFactor > 0 && Number.isFinite(Number(nutrients.caloriesKcal))
        ? round(Number(nutrients.caloriesKcal) * defaultPortionFactor, 1)
        : null,
    proteinG:
      defaultPortionFactor > 0 && Number.isFinite(Number(nutrients.proteinG))
        ? round(Number(nutrients.proteinG) * defaultPortionFactor, 1)
        : null,
    carbsG:
      defaultPortionFactor > 0 && Number.isFinite(Number(nutrients.carbsG))
        ? round(Number(nutrients.carbsG) * defaultPortionFactor, 1)
        : null,
    fatG:
      defaultPortionFactor > 0 && Number.isFinite(Number(nutrients.fatG))
        ? round(Number(nutrients.fatG) * defaultPortionFactor, 1)
        : null,
  };

  return {
    fdcId: food.fdcId,
    description: food.description || "",
    dataType: food.dataType || "",
    brandName: food.brandName || "",
    brandOwner: food.brandOwner || "",
    foodCategory:
      (typeof food.foodCategory === "string" && food.foodCategory) ||
      food.foodCategory?.description ||
      food.brandedFoodCategory ||
      "",
    servingSize: food.servingSize ?? null,
    servingSizeUnit: food.servingSizeUnit || "",
    nutrients,
    nutrientsPer100g: nutrients,
    portionOptions,
    defaultPortionOption,
    display,
  };
};

const usdaFetch = async (url, options = {}) => {
  const controller = new AbortController();
  const timeoutMs = Number(process.env.USDA_TIMEOUT_MS || 12000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      const bodyText = await response.text();
      throw new AppError(
        `USDA API request failed (${response.status}): ${bodyText || "Unknown error"}`,
        httpStatus.BAD_GATEWAY
      );
    }
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new AppError("USDA API request timed out.", httpStatus.GATEWAY_TIMEOUT);
    }
    if (error instanceof AppError) throw error;
    throw new AppError(`USDA API error: ${error.message}`, httpStatus.BAD_GATEWAY);
  } finally {
    clearTimeout(timeout);
  }
};

const buildUsdaSearchUrl = ({ query, pageNumber = 1, pageSize = 20 }) => {
  if (!USDA_API_KEY) {
    throw new AppError("USDA_API_KEY is missing. Please configure it in environment variables.", httpStatus.INTERNAL_SERVER_ERROR);
  }

  const params = new URLSearchParams({
    api_key: USDA_API_KEY,
    query,
    pageNumber: String(pageNumber),
    pageSize: String(pageSize),
  });

  return `${USDA_API_BASE}/foods/search?${params.toString()}`;
};

const normalizeDiaryDate = (value, fieldName = "date") => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new AppError(`${fieldName} must be a valid date.`, httpStatus.BAD_REQUEST);
  }

  date.setHours(0, 0, 0, 0);
  return date;
};

const getNumericValue = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
};

const getTrimmedString = (...values) => {
  for (const value of values) {
    const normalized = asString(value);
    if (normalized) {
      return normalized;
    }
  }

  return "";
};

const getNutrientValueFromSource = (source, keys) => getNumericValue(...keys.map((key) => source?.[key]));

const resolveImageUrl = (body, currentEntry = null) =>
  getTrimmedString(body.imageUrl, body.image?.url, body.image?.secure_url, currentEntry?.imageUrl);

const normalizeMealType = (value, required = true) => {
  const normalized = asString(value).toLowerCase();

  if (!normalized) {
    if (!required) {
      return "";
    }
    throw new AppError("mealType is required.", httpStatus.BAD_REQUEST);
  }

  if (!DIARY_MEAL_TYPE_SET.has(normalized)) {
    throw new AppError("mealType must be one of: breakfast, lunch, dinner, snack, other.", httpStatus.BAD_REQUEST);
  }

  return normalized;
};

const calculateMacroAndCalorieTargets = ({
  weightKg,
  goal,
  proteinPerKg,
  carbsPerKg,
  fatPerKg,
  caloriesPerKg,
}) => {
  const proteinG = round(weightKg * proteinPerKg, 1);
  const carbsG = round(weightKg * carbsPerKg, 1);
  const fatG = round(weightKg * fatPerKg, 1);

  const proteinCalories = round(proteinG * 4, 1);
  const carbsCalories = round(carbsG * 4, 1);
  const fatCalories = round(fatG * 9, 1);
  const macroCalories = round(proteinCalories + carbsCalories + fatCalories, 1);

  const goalRange = GOAL_KCAL_RANGE[goal];
  const minCalories = round(weightKg * goalRange.min, 0);
  const maxCalories = round(weightKg * goalRange.max, 0);
  const recommendedCalories =
    caloriesPerKg !== undefined
      ? round(weightKg * caloriesPerKg, 0)
      : round(weightKg * ((goalRange.min + goalRange.max) / 2), 0);
  const remainingCalories = round(recommendedCalories - macroCalories, 1);

  return {
    weightKg: round(weightKg, 2),
    goal,
    multipliers: {
      proteinPerKg,
      carbsPerKg,
      fatPerKg,
    },
    macros: {
      proteinG,
      carbsG,
      fatG,
    },
    calories: {
      proteinCalories,
      carbsCalories,
      fatCalories,
      macroCalories,
      recommendedCalories,
      minCalories,
      maxCalories,
      remainingCalories,
    },
  };
};

const resolveTargetSummaryFromSource = (source, user, { weightRequired = false } = {}) => {
  const weightKg = resolveWeightKgFromSource(source, user, weightRequired);
  if (!weightKg) {
    return null;
  }

  const goal = parseGoal(source.goal);
  const proteinPerKg = parseNumber(source.proteinPerKg, "proteinPerKg", 0, false) ?? DEFAULT_MACRO_PER_KG.protein;
  const carbsPerKg = parseNumber(source.carbsPerKg, "carbsPerKg", 0, false) ?? DEFAULT_MACRO_PER_KG.carbs;
  const fatPerKg = parseNumber(source.fatPerKg, "fatPerKg", 0, false) ?? DEFAULT_MACRO_PER_KG.fat;
  const caloriesPerKg = parseNumber(source.caloriesPerKg, "caloriesPerKg", 1, false);

  return calculateMacroAndCalorieTargets({
    weightKg,
    goal,
    proteinPerKg,
    carbsPerKg,
    fatPerKg,
    caloriesPerKg,
  });
};

const buildMacroProgress = (totals, targetMacros = null) => {
  const defineMacroProgress = (consumedG, targetG) => {
    if (!Number.isFinite(targetG) || targetG <= 0) {
      return {
        consumedG: round(consumedG, 1),
        targetG: null,
        remainingG: null,
        progressPercent: null,
      };
    }

    return {
      consumedG: round(consumedG, 1),
      targetG: round(targetG, 1),
      remainingG: round(targetG - consumedG, 1),
      progressPercent: round((consumedG / targetG) * 100, 1),
    };
  };

  return {
    carbs: defineMacroProgress(Number(totals.carbsG || 0), Number(targetMacros?.carbsG)),
    protein: defineMacroProgress(Number(totals.proteinG || 0), Number(targetMacros?.proteinG)),
    fat: defineMacroProgress(Number(totals.fatG || 0), Number(targetMacros?.fatG)),
  };
};

const buildEnergySummary = (totals, calorieTargets = null, burnedKcal = 0) => {
  const eatenKcal = round(Number(totals.caloriesKcal || 0), 1);
  const caloriesBurned = round(Number(burnedKcal || 0), 1);
  const netKcal = round(eatenKcal - caloriesBurned, 1);
  const goalKcal = Number.isFinite(Number(calorieTargets?.recommendedCalories))
    ? round(Number(calorieTargets.recommendedCalories), 1)
    : null;
  const remainingKcal = goalKcal === null ? null : round(goalKcal - netKcal, 1);

  let status = "unknown";
  if (remainingKcal !== null) {
    status = remainingKcal >= 0 ? "under" : "over";
  }

  return {
    eatenKcal,
    burnedKcal: caloriesBurned,
    netKcal,
    goalKcal,
    remainingKcal,
    status,
  };
};

const buildMealCalorieRecommendation = (mealType, mealTotals, calorieTargets = null) => {
  if (!calorieTargets) return null;

  const distribution = MEAL_KCAL_DISTRIBUTION[mealType] || MEAL_KCAL_DISTRIBUTION.other;
  const minBase = Number.isFinite(Number(calorieTargets.minCalories))
    ? Number(calorieTargets.minCalories)
    : Number(calorieTargets.recommendedCalories || 0);
  const maxBase = Number.isFinite(Number(calorieTargets.maxCalories))
    ? Number(calorieTargets.maxCalories)
    : Number(calorieTargets.recommendedCalories || 0);

  const minKcal = round(minBase * distribution.min, 0);
  const maxKcal = round(maxBase * distribution.max, 0);
  const eatenKcal = round(Number(mealTotals.caloriesKcal || 0), 1);

  return {
    recommendedCalories: {
      minKcal,
      maxKcal,
    },
    eatenKcal,
    remainingCalories: {
      toMinKcal: round(minKcal - eatenKcal, 1),
      toMaxKcal: round(maxKcal - eatenKcal, 1),
    },
  };
};

const getDayRange = (dateValue) => {
  const start = new Date(dateValue);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
};

const getBurnedCaloriesForDate = async (userId, dateValue) => {
  const { start, end } = getDayRange(dateValue);
  const [aggregate] = await WorkoutLog.aggregate([
    {
      $match: {
        user: userId,
        completedAt: { $gte: start, $lt: end },
      },
    },
    {
      $group: {
        _id: null,
        caloriesBurned: { $sum: "$caloriesBurned" },
      },
    },
  ]);

  return round(Number(aggregate?.caloriesBurned || 0), 1);
};

const escapeRegex = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildNutritionTotals = (entries = []) =>
  entries.reduce(
    (totals, entry) => ({
      caloriesKcal: round(totals.caloriesKcal + Number(entry.caloriesKcal || 0), 1),
      proteinG: round(totals.proteinG + Number(entry.proteinG || 0), 1),
      carbsG: round(totals.carbsG + Number(entry.carbsG || 0), 1),
      fatG: round(totals.fatG + Number(entry.fatG || 0), 1),
      fiberG: round(totals.fiberG + Number(entry.fiberG || 0), 1),
      sugarG: round(totals.sugarG + Number(entry.sugarG || 0), 1),
      totalGrams: round(totals.totalGrams + Number(entry.totalGrams || 0), 1),
    }),
    {
      caloriesKcal: 0,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      fiberG: 0,
      sugarG: 0,
      totalGrams: 0,
    }
  );

const buildMacroPercentages = (totals) => {
  const proteinCalories = Number(totals.proteinG || 0) * 4;
  const carbsCalories = Number(totals.carbsG || 0) * 4;
  const fatCalories = Number(totals.fatG || 0) * 9;
  const totalMacroCalories = proteinCalories + carbsCalories + fatCalories;

  if (totalMacroCalories <= 0) {
    return {
      proteinPercent: 0,
      carbsPercent: 0,
      fatPercent: 0,
    };
  }

  return {
    proteinPercent: round((proteinCalories / totalMacroCalories) * 100, 1),
    carbsPercent: round((carbsCalories / totalMacroCalories) * 100, 1),
    fatPercent: round((fatCalories / totalMacroCalories) * 100, 1),
  };
};

const buildEntryServingGrams = (entry) => {
  const quantity = Number(entry.quantity || 0);
  const totalGrams = Number(entry.totalGrams || 0);

  if (quantity > 0 && totalGrams > 0) {
    return round(totalGrams / quantity, 1);
  }

  return round(totalGrams, 1);
};

const buildEntryPer100gNutrients = (entry) => {
  const totalGrams = Number(entry.totalGrams || 0);
  if (totalGrams <= 0) {
    return null;
  }

  const factor = 100 / totalGrams;
  return {
    caloriesKcal: round(Number(entry.caloriesKcal || 0) * factor, 1),
    proteinG: round(Number(entry.proteinG || 0) * factor, 1),
    carbsG: round(Number(entry.carbsG || 0) * factor, 1),
    fatG: round(Number(entry.fatG || 0) * factor, 1),
    fiberG: round(Number(entry.fiberG || 0) * factor, 1),
    sugarG: round(Number(entry.sugarG || 0) * factor, 1),
  };
};

const toNutritionEntryResponse = (entry) => {
  const totalGrams = round(Number(entry.totalGrams || 0), 1);
  const servingGrams = buildEntryServingGrams(entry);
  const nutrientsPer100g = buildEntryPer100gNutrients(entry);

  return {
    id: entry._id,
    entryDate: entry.entryDate,
    date: entry.entryDate,
    mealType: entry.mealType,
    mealLabel: DIARY_MEAL_LABELS[entry.mealType] || entry.mealType,
    foodName: entry.foodName,
    brandName: entry.brandName || "",
    source: entry.source,
    fdcId: entry.fdcId || null,
    quantity: entry.quantity,
    servingLabel: entry.servingLabel,
    servingGrams,
    portionGrams: servingGrams,
    totalGrams,
    caloriesKcal: round(Number(entry.caloriesKcal || 0), 1),
    proteinG: round(Number(entry.proteinG || 0), 1),
    carbsG: round(Number(entry.carbsG || 0), 1),
    fatG: round(Number(entry.fatG || 0), 1),
    fiberG: round(Number(entry.fiberG || 0), 1),
    sugarG: round(Number(entry.sugarG || 0), 1),
    nutrientsPer100g,
    imageUrl: entry.imageUrl || "",
    notes: entry.notes || "",
    isFavorite: Boolean(entry.isFavorite),
    favoriteKind: "food",
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
};

const buildFavoriteEntryKey = (entry) => {
  if (Number.isFinite(Number(entry.fdcId)) && Number(entry.fdcId) > 0) {
    return `fdc:${Number(entry.fdcId)}`;
  }

  return [
    asString(entry.foodName).toLowerCase(),
    asString(entry.brandName).toLowerCase(),
    asString(entry.servingLabel).toLowerCase(),
    asString(entry.source).toLowerCase(),
  ].join("|");
};

const dedupeNutritionEntries = (entries = [], { limit = 20, favoritesOnly = false } = {}) => {
  const seen = new Set();
  const deduped = [];

  for (const entry of entries) {
    const key = buildFavoriteEntryKey(entry);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    if (favoritesOnly && !entry.isFavorite) {
      continue;
    }
    deduped.push(entry);
    if (deduped.length >= limit) {
      break;
    }
  }

  return deduped;
};

const getFavoriteRecipeRefList = (user) =>
  (user?.favoriteRecipeRefs || [])
    .map((item) => ({
      recipeId: String(item?.recipe || item || ""),
      savedAt: item?.savedAt ? new Date(item.savedAt) : new Date(0),
    }))
    .filter((item) => item.recipeId);

const isRecipeAccessibleToUser = (recipe, user) => {
  if (!recipe || !recipe.isActive || recipe.status !== "published") {
    return false;
  }

  if (recipe.userType === "normal_user") {
    return true;
  }

  return (
    isPremiumActiveUser(user) &&
    recipe.userType === "premium_user" &&
    recipe.assignedUser &&
    String(recipe.assignedUser) === String(user._id)
  );
};

const buildFavoriteMealItems = (entries = []) =>
  entries.map((entry) => ({
    foodName: entry.foodName,
    brandName: entry.brandName || "",
    source: entry.source,
    fdcId: entry.fdcId || null,
    quantity: round(Number(entry.quantity || 0), 2),
    servingLabel: entry.servingLabel,
    totalGrams: round(Number(entry.totalGrams || 0), 1),
    caloriesKcal: round(Number(entry.caloriesKcal || 0), 1),
    proteinG: round(Number(entry.proteinG || 0), 1),
    carbsG: round(Number(entry.carbsG || 0), 1),
    fatG: round(Number(entry.fatG || 0), 1),
    fiberG: round(Number(entry.fiberG || 0), 1),
    sugarG: round(Number(entry.sugarG || 0), 1),
    imageUrl: entry.imageUrl || "",
  }));

const buildFavoriteMealSignature = (mealType, items = []) =>
  [
    normalizeMealType(mealType),
    ...items.map((item) =>
      [
        Number.isFinite(Number(item.fdcId)) ? `fdc:${Number(item.fdcId)}` : asString(item.foodName).toLowerCase(),
        asString(item.brandName).toLowerCase(),
        round(Number(item.quantity || 0), 2),
        asString(item.servingLabel).toLowerCase(),
        round(Number(item.totalGrams || 0), 1),
      ].join("|")
    ),
  ].join("||");

const buildFavoriteMealTitle = (mealType, items = [], providedTitle = "") => {
  const manualTitle = asString(providedTitle);
  if (manualTitle) {
    return manualTitle.slice(0, 160);
  }

  const mealLabel = toMealLabel(mealType);
  const uniqueNames = [...new Set(items.map((item) => asString(item.foodName)).filter(Boolean))];
  if (uniqueNames.length === 0) {
    return mealLabel;
  }
  if (uniqueNames.length === 1) {
    return `${mealLabel}: ${uniqueNames[0]}`.slice(0, 160);
  }
  if (uniqueNames.length === 2) {
    return `${mealLabel}: ${uniqueNames[0]}, ${uniqueNames[1]}`.slice(0, 160);
  }

  return `${mealLabel}: ${uniqueNames[0]}, ${uniqueNames[1]} +${uniqueNames.length - 2}`.slice(0, 160);
};

const buildFavoriteMealNotes = (items = []) =>
  items
    .map((item) => asString(item.foodName))
    .filter(Boolean)
    .join(", ")
    .slice(0, 500);

const buildFavoriteMealResponse = (favoriteMeal) => ({
  id: favoriteMeal._id,
  entryDate: favoriteMeal.sourceDate || favoriteMeal.savedAt,
  date: favoriteMeal.sourceDate || favoriteMeal.savedAt,
  mealType: favoriteMeal.mealType,
  mealLabel: toMealLabel(favoriteMeal.mealType),
  foodName: favoriteMeal.title,
  brandName:
    Number(favoriteMeal.itemCount || favoriteMeal.items?.length || 0) > 0
      ? `${Number(favoriteMeal.itemCount || favoriteMeal.items?.length || 0)} items`
      : "",
  source: "saved_meal",
  fdcId: null,
  quantity: 1,
  servingLabel: "saved meal",
  servingGrams: 0,
  portionGrams: 0,
  totalGrams: round(Number(favoriteMeal.totalGrams || 0), 1),
  caloriesKcal: round(Number(favoriteMeal.caloriesKcal || 0), 1),
  proteinG: round(Number(favoriteMeal.proteinG || 0), 1),
  carbsG: round(Number(favoriteMeal.carbsG || 0), 1),
  fatG: round(Number(favoriteMeal.fatG || 0), 1),
  fiberG: round(Number(favoriteMeal.fiberG || 0), 1),
  sugarG: round(Number(favoriteMeal.sugarG || 0), 1),
  nutrientsPer100g: null,
  imageUrl: favoriteMeal.imageUrl || "",
  notes: favoriteMeal.notes || "",
  isFavorite: true,
  favoriteKind: "meal",
  createdAt: favoriteMeal.savedAt,
  updatedAt: favoriteMeal.updatedAt || favoriteMeal.savedAt,
});

const buildFavoriteRecipeResponse = (recipe) => ({
  id: recipe._id,
  entryDate: recipe.updatedAt || recipe.createdAt,
  date: recipe.updatedAt || recipe.createdAt,
  mealType: recipe.recipeType || "other",
  mealLabel: toMealLabel(recipe.recipeType),
  foodName: recipe.recipeName,
  brandName: "",
  source: "recipe",
  fdcId: null,
  quantity: 1,
  servingLabel: "recipe",
  servingGrams: 0,
  portionGrams: 0,
  totalGrams: 0,
  caloriesKcal: round(Number(recipe.caloriesKcal || 0), 1),
  proteinG: round(Number(recipe.proteinG || 0), 1),
  carbsG: round(Number(recipe.carbsG || 0), 1),
  fatG: round(Number(recipe.fatG || 0), 1),
  fiberG: 0,
  sugarG: 0,
  nutrientsPer100g: null,
  imageUrl: recipe.recipeImages?.[0]?.url || "",
  notes: Array.isArray(recipe.ingredients) ? recipe.ingredients.join(", ").slice(0, 500) : "",
  isFavorite: true,
  favoriteKind: "recipe",
  createdAt: recipe.createdAt,
  updatedAt: recipe.updatedAt,
});

const resolveEntryNutrients = (body, totalGrams, currentEntry = null) => {
  const nutrientSource = body.nutrients && typeof body.nutrients === "object" ? body.nutrients : {};
  const per100gSourceCandidates = [
    body.nutrientsPer100g,
    body.per100gNutrients,
    body.per100g,
    nutrientSource.per100g,
  ];
  const per100gSource = per100gSourceCandidates.find((value) => value && typeof value === "object") || null;

  if (per100gSource && totalGrams > 0) {
    const factor = totalGrams / 100;
    return {
      caloriesKcal: round((getNutrientValueFromSource(per100gSource, ["caloriesKcal", "calories"]) || 0) * factor, 1),
      proteinG: round((getNutrientValueFromSource(per100gSource, ["proteinG", "protein"]) || 0) * factor, 1),
      carbsG: round((getNutrientValueFromSource(per100gSource, ["carbsG", "carbs"]) || 0) * factor, 1),
      fatG: round((getNutrientValueFromSource(per100gSource, ["fatG", "fat"]) || 0) * factor, 1),
      fiberG: round((getNutrientValueFromSource(per100gSource, ["fiberG", "fiber"]) || 0) * factor, 1),
      sugarG: round((getNutrientValueFromSource(per100gSource, ["sugarG", "sugar"]) || 0) * factor, 1),
    };
  }

  return {
    caloriesKcal: round(
      getNumericValue(body.caloriesKcal, body.calories, nutrientSource.caloriesKcal, nutrientSource.calories, currentEntry?.caloriesKcal, 0) || 0,
      1
    ),
    proteinG: round(
      getNumericValue(body.proteinG, body.protein, nutrientSource.proteinG, nutrientSource.protein, currentEntry?.proteinG, 0) || 0,
      1
    ),
    carbsG: round(
      getNumericValue(body.carbsG, body.carbs, nutrientSource.carbsG, nutrientSource.carbs, currentEntry?.carbsG, 0) || 0,
      1
    ),
    fatG: round(
      getNumericValue(body.fatG, body.fat, nutrientSource.fatG, nutrientSource.fat, currentEntry?.fatG, 0) || 0,
      1
    ),
    fiberG: round(
      getNumericValue(body.fiberG, body.fiber, nutrientSource.fiberG, nutrientSource.fiber, currentEntry?.fiberG, 0) || 0,
      1
    ),
    sugarG: round(
      getNumericValue(body.sugarG, body.sugar, nutrientSource.sugarG, nutrientSource.sugar, currentEntry?.sugarG, 0) || 0,
      1
    ),
  };
};

const buildNutritionEntryPayload = (body, currentEntry = null) => {
  const entryDate = normalizeDiaryDate(body.entryDate || body.date || currentEntry?.entryDate, "entryDate");
  const foodName = getTrimmedString(
    body.foodName,
    body.description,
    body.name,
    body.food?.description,
    currentEntry?.foodName
  );
  if (!foodName) {
    throw new AppError("foodName is required.", httpStatus.BAD_REQUEST);
  }

  const quantity =
    parseNumber(body.quantity ?? currentEntry?.quantity, "quantity", 0.01, currentEntry ? false : true) ??
    currentEntry?.quantity;
  const servingLabel = getTrimmedString(body.servingLabel, body.unit, body.measurement, currentEntry?.servingLabel, "gram");

  let totalGrams = getNumericValue(body.totalGrams, body.grams, body.gramWeight);
  const servingGrams = getNumericValue(body.servingGrams, body.portionGrams);
  if (totalGrams === undefined && servingGrams !== undefined && quantity !== undefined) {
    totalGrams = quantity * servingGrams;
  }

  if (totalGrams === undefined && ["gram", "grams", "g"].includes(servingLabel.toLowerCase()) && quantity !== undefined) {
    totalGrams = quantity;
  }

  totalGrams = round(Math.max(0, Number(totalGrams ?? currentEntry?.totalGrams ?? 0)), 1);

  const mealType = normalizeMealType(body.mealType || currentEntry?.mealType || "breakfast");
  const brandName = getTrimmedString(body.brandName, body.brandOwner, currentEntry?.brandName);
  const fdcId = getNumericValue(body.fdcId, body.food?.fdcId, currentEntry?.fdcId) || null;
  const source = getTrimmedString(body.source, currentEntry?.source, fdcId ? "usda" : "manual").toLowerCase();
  if (!DIARY_SOURCE_SET.has(source)) {
    throw new AppError("source must be one of: manual, usda.", httpStatus.BAD_REQUEST);
  }

  const notes = getTrimmedString(body.notes, currentEntry?.notes);
  if (notes.length > 500) {
    throw new AppError("notes should not exceed 500 characters.", httpStatus.BAD_REQUEST);
  }

  const nutrients = resolveEntryNutrients(body, totalGrams, currentEntry);

  return {
    entryDate,
    mealType,
    foodName,
    brandName,
    source,
    fdcId,
    quantity,
    servingLabel,
    totalGrams,
    ...nutrients,
    imageUrl: resolveImageUrl(body, currentEntry),
    notes,
    isFavorite:
      body.isFavorite === undefined ? Boolean(currentEntry?.isFavorite) : Boolean(body.isFavorite),
  };
};

const getOwnedNutritionEntry = async (entryId, userId) => {
  if (!entryId || !/^[0-9a-fA-F]{24}$/.test(String(entryId))) {
    throw new AppError("entryId must be a valid id.", httpStatus.BAD_REQUEST);
  }

  const entry = await NutritionEntry.findOne({ _id: entryId, user: userId });
  if (!entry) {
    throw new AppError("Nutrition entry not found.", httpStatus.NOT_FOUND);
  }

  return entry;
};

const buildNutritionDiaryResponse = (date, entries, options = {}) => {
  const targets = options.targets || null;
  const burnedKcal = Number(options.burnedKcal || 0);
  const totals = buildNutritionTotals(entries);
  const macroProgress = buildMacroProgress(totals, targets?.macros || null);
  const energy = buildEnergySummary(totals, targets?.calories || null, burnedKcal);

  const meals = DIARY_MEAL_TYPES.map((mealType) => {
    const mealEntries = entries.filter((entry) => entry.mealType === mealType);
    const mealTotals = buildNutritionTotals(mealEntries);
    const mealMacroPercentages = buildMacroPercentages(mealTotals);
    const recommendation = buildMealCalorieRecommendation(mealType, mealTotals, targets?.calories || null);

    return {
      mealType,
      mealLabel: DIARY_MEAL_LABELS[mealType],
      totalEntries: mealEntries.length,
      totals: mealTotals,
      macroPercentages: mealMacroPercentages,
      recommendation,
      entries: mealEntries.map(toNutritionEntryResponse),
    };
  });

  return {
    date,
    totals,
    macroPercentages: buildMacroPercentages(totals),
    macroProgress,
    targets,
    energy,
    totalEntries: entries.length,
    meals,
    mealRecommendations: meals.map((meal) => ({
      mealType: meal.mealType,
      mealLabel: meal.mealLabel,
      recommendation: meal.recommendation,
      totals: meal.totals,
      macroPercentages: meal.macroPercentages,
    })),
    entries: entries.map(toNutritionEntryResponse),
  };
};

export const calculateMacroTargets = catchAsync(async (req, res) => {
  const summary = resolveTargetSummaryFromSource(req.body, req.user, { weightRequired: true });

  res.status(httpStatus.OK).json({
    success: true,
    data: {
      ...summary,
      notes: {
        formula: "protein = weight*proteinPerKg, carbs = weight*carbsPerKg, fat = weight*fatPerKg",
      },
    },
  });
});

export const searchFoods = catchAsync(async (req, res) => {
  const query = asString(req.query.query || req.query.q);
  if (!query || query.length < 2) {
    throw new AppError("query must be at least 2 characters.", httpStatus.BAD_REQUEST);
  }

  const page = parseNumber(req.query.page, "page", 1, false) ?? 1;
  const pageSize = parseNumber(req.query.pageSize || req.query.limit, "pageSize", 1, false) ?? 20;
  const safePageSize = Math.min(Math.max(Math.floor(pageSize), 1), 50);

  const url = buildUsdaSearchUrl({
    query,
    pageNumber: Math.floor(page),
    pageSize: safePageSize,
  });

  const result = await usdaFetch(url);

  const foods = Array.isArray(result.foods) ? result.foods.map(mapFoodSummary) : [];

  res.status(httpStatus.OK).json({
    success: true,
    data: {
      totalHits: result.totalHits || 0,
      currentPage: result.currentPage || Math.floor(page),
      totalPages: result.totalPages || 0,
      foods,
    },
  });
});

export const getFoodSuggestions = catchAsync(async (req, res) => {
  const query = asString(req.query.query || req.query.q).toLowerCase();
  if (!query || query.length < 2) {
    return res.status(httpStatus.OK).json({
      success: true,
      data: [],
    });
  }

  const limit = parseNumber(req.query.limit, "limit", 1, false) ?? 10;
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 20);
  const pageSize = Math.min(Math.max(safeLimit * 5, 30), 100);

  const url = buildUsdaSearchUrl({
    query,
    pageNumber: 1,
    pageSize,
  });

  const result = await usdaFetch(url);
  const foods = Array.isArray(result.foods) ? result.foods : [];

  const unique = new Map();
  for (const food of foods) {
    const description = asString(food.description);
    if (!description) continue;

    const normalized = description.toLowerCase();
    if (!normalized.includes(query)) continue;
    if (!unique.has(normalized)) {
      unique.set(normalized, {
        label: description,
        value: normalized,
        fdcId: food.fdcId,
      });
    }
  }

  const suggestions = Array.from(unique.values())
    .sort((a, b) => {
      const aStarts = a.value.startsWith(query) ? 0 : 1;
      const bStarts = b.value.startsWith(query) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.label.localeCompare(b.label);
    })
    .slice(0, safeLimit);

  res.status(httpStatus.OK).json({
    success: true,
    data: suggestions,
  });
});

export const getFoodByFdcId = catchAsync(async (req, res) => {
  const fdcId = parseNumber(req.params.fdcId, "fdcId", 1, true);
  const params = new URLSearchParams({ api_key: USDA_API_KEY });
  const url = `${USDA_API_BASE}/food/${Math.floor(fdcId)}?${params.toString()}`;

  const result = await usdaFetch(url);

  res.status(httpStatus.OK).json({
    success: true,
    data: mapFoodSummary(result),
  });
});

export const getNutritionDiary = catchAsync(async (req, res) => {
  const entryDate = normalizeDiaryDate(req.query.date || req.query.entryDate);
  const [entries, burnedKcal] = await Promise.all([
    NutritionEntry.find({
      user: req.user._id,
      entryDate,
    }).sort({ mealType: 1, createdAt: 1 }),
    getBurnedCaloriesForDate(req.user._id, entryDate),
  ]);
  const targets = resolveTargetSummaryFromSource(req.query, req.user, { weightRequired: false });

  res.status(httpStatus.OK).json({
    success: true,
    data: buildNutritionDiaryResponse(entryDate, entries, {
      targets,
      burnedKcal,
    }),
  });
});

export const getNutritionHistory = catchAsync(async (req, res) => {
  const page = parseNumber(req.query.page, "page", 1, false) ?? 1;
  const limit = parseNumber(req.query.limit, "limit", 1, false) ?? 20;
  const safePage = Math.max(Math.floor(page), 1);
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const skip = (safePage - 1) * safeLimit;

  const filter = {
    user: req.user._id,
  };

  const mealTypeQuery = asString(req.query.mealType);
  if (mealTypeQuery) {
    filter.mealType = normalizeMealType(mealTypeQuery);
  }

  const queryText = asString(req.query.query || req.query.q);
  if (queryText) {
    filter.foodName = {
      $regex: escapeRegex(queryText),
      $options: "i",
    };
  }

  const [entries, total] = await Promise.all([
    NutritionEntry.find(filter)
      .sort({ entryDate: -1, updatedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(safeLimit),
    NutritionEntry.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.ceil(total / safeLimit),
      entries: entries.map(toNutritionEntryResponse),
    },
  });
});

export const getNutritionFavorites = catchAsync(async (req, res) => {
  const limit = parseNumber(req.query.limit, "limit", 1, false) ?? 20;
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const entries = await NutritionEntry.find({
    user: req.user._id,
  })
    .sort({ entryDate: -1, updatedAt: -1, createdAt: -1 })
    .limit(Math.min(safeLimit * 10, 1000));
  const favorites = dedupeNutritionEntries(entries, {
    limit: safeLimit,
    favoritesOnly: true,
  });

  res.status(httpStatus.OK).json({
    success: true,
    data: favorites.map(toNutritionEntryResponse),
  });
});

export const getNutritionFavoriteSections = catchAsync(async (req, res) => {
  const limit = parseNumber(req.query.limit, "limit", 1, false) ?? 20;
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const [entries, favoriteRecipes] = await Promise.all([
    NutritionEntry.find({
      user: req.user._id,
    })
      .sort({ entryDate: -1, updatedAt: -1, createdAt: -1 })
      .limit(Math.min(safeLimit * 5, 500)),
    (async () => {
      const favoriteRecipeRefs = getFavoriteRecipeRefList(req.user);
      if (favoriteRecipeRefs.length === 0) {
        return [];
      }

      const favoriteRecipeSavedAtMap = new Map(
        favoriteRecipeRefs.map((item) => [item.recipeId, item.savedAt])
      );
      const recipes = await Recipe.find({
        _id: { $in: favoriteRecipeRefs.map((item) => item.recipeId) },
        isActive: true,
        status: "published",
      });

      return recipes
        .filter((recipe) => isRecipeAccessibleToUser(recipe, req.user))
        .sort((a, b) => {
          const aSavedAt = favoriteRecipeSavedAtMap.get(String(a._id)) || new Date(0);
          const bSavedAt = favoriteRecipeSavedAtMap.get(String(b._id)) || new Date(0);
          return bSavedAt.getTime() - aSavedAt.getTime();
        })
        .slice(0, safeLimit);
    })(),
  ]);
  const foods = dedupeNutritionEntries(entries, {
    limit: safeLimit,
    favoritesOnly: true,
  });
  const meals = [...(req.user.favoriteMeals || [])]
    .sort(
      (a, b) =>
        new Date(b.updatedAt || b.savedAt || 0).getTime() -
        new Date(a.updatedAt || a.savedAt || 0).getTime()
    )
    .slice(0, safeLimit);

  res.status(httpStatus.OK).json({
    success: true,
    data: {
      foods: foods.map(toNutritionEntryResponse),
      meals: meals.map(buildFavoriteMealResponse),
      recipes: favoriteRecipes.map(buildFavoriteRecipeResponse),
    },
  });
});

export const saveNutritionFavoriteMeal = catchAsync(async (req, res) => {
  const entryDate = normalizeDiaryDate(req.body.entryDate || req.body.date, "date");
  const mealType = normalizeMealType(req.body.mealType || req.query.mealType || "breakfast");
  const entries = await NutritionEntry.find({
    user: req.user._id,
    entryDate,
    mealType,
  }).sort({ createdAt: 1 });

  if (entries.length === 0) {
    throw new AppError(
      "No tracked items found for this meal on the selected date.",
      httpStatus.BAD_REQUEST
    );
  }

  const items = buildFavoriteMealItems(entries);
  const totals = buildNutritionTotals(entries);
  const signature = buildFavoriteMealSignature(mealType, items);
  const now = new Date();
  const title = buildFavoriteMealTitle(mealType, items, req.body.title);
  const notes = buildFavoriteMealNotes(items);
  const imageUrl = items.find((item) => item.imageUrl)?.imageUrl || "";
  if (!Array.isArray(req.user.favoriteMeals)) {
    req.user.favoriteMeals = [];
  }

  let favoriteMeal = (req.user.favoriteMeals || []).find(
    (meal) => meal.signature === signature
  );
  const wasExisting = Boolean(favoriteMeal);

  if (favoriteMeal) {
    favoriteMeal.title = title;
    favoriteMeal.mealType = mealType;
    favoriteMeal.sourceDate = entryDate;
    favoriteMeal.signature = signature;
    favoriteMeal.itemCount = items.length;
    favoriteMeal.items = items;
    favoriteMeal.totalGrams = totals.totalGrams;
    favoriteMeal.caloriesKcal = totals.caloriesKcal;
    favoriteMeal.proteinG = totals.proteinG;
    favoriteMeal.carbsG = totals.carbsG;
    favoriteMeal.fatG = totals.fatG;
    favoriteMeal.fiberG = totals.fiberG;
    favoriteMeal.sugarG = totals.sugarG;
    favoriteMeal.imageUrl = imageUrl;
    favoriteMeal.notes = notes;
    favoriteMeal.updatedAt = now;
  } else {
    req.user.favoriteMeals.push({
      title,
      mealType,
      signature,
      sourceDate: entryDate,
      itemCount: items.length,
      items,
      totalGrams: totals.totalGrams,
      caloriesKcal: totals.caloriesKcal,
      proteinG: totals.proteinG,
      carbsG: totals.carbsG,
      fatG: totals.fatG,
      fiberG: totals.fiberG,
      sugarG: totals.sugarG,
      imageUrl,
      notes,
      savedAt: now,
      updatedAt: now,
    });
    favoriteMeal = req.user.favoriteMeals[req.user.favoriteMeals.length - 1];
  }

  await req.user.save({ validateBeforeSave: false });

  res.status(wasExisting ? httpStatus.OK : httpStatus.CREATED).json({
    success: true,
    message: wasExisting
      ? "Favorite meal updated successfully."
      : "Meal saved to favorites successfully.",
    data: buildFavoriteMealResponse(favoriteMeal),
  });
});

export const deleteNutritionFavoriteMeal = catchAsync(async (req, res) => {
  if (!Array.isArray(req.user.favoriteMeals)) {
    req.user.favoriteMeals = [];
  }
  const favoriteMeal = req.user.favoriteMeals?.id(req.params.mealFavoriteId);
  if (!favoriteMeal) {
    throw new AppError("Favorite meal not found.", httpStatus.NOT_FOUND);
  }

  req.user.favoriteMeals.pull({ _id: req.params.mealFavoriteId });
  await req.user.save({ validateBeforeSave: false });

  res.status(httpStatus.OK).json({
    success: true,
    message: "Favorite meal removed successfully.",
  });
});

export const getNutritionDiaryEntryById = catchAsync(async (req, res) => {
  const entry = await getOwnedNutritionEntry(req.params.entryId, req.user._id);

  res.status(httpStatus.OK).json({
    success: true,
    data: toNutritionEntryResponse(entry),
  });
});

export const createNutritionDiaryEntry = catchAsync(async (req, res) => {
  const payload = buildNutritionEntryPayload(req.body);
  const entry = await NutritionEntry.create({
    user: req.user._id,
    ...payload,
  });

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Nutrition entry tracked successfully.",
    data: toNutritionEntryResponse(entry),
  });
});

export const updateNutritionDiaryEntry = catchAsync(async (req, res) => {
  const entry = await getOwnedNutritionEntry(req.params.entryId, req.user._id);
  const payload = buildNutritionEntryPayload(req.body, entry);

  Object.assign(entry, payload);
  await entry.save();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Nutrition entry updated successfully.",
    data: toNutritionEntryResponse(entry),
  });
});

export const deleteNutritionDiaryEntry = catchAsync(async (req, res) => {
  const entry = await getOwnedNutritionEntry(req.params.entryId, req.user._id);
  await entry.deleteOne();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Nutrition entry deleted successfully.",
  });
});
