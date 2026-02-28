import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";

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

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
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

const resolveWeightKg = (req) => {
  const weightKgInput = parseNumber(req.body.weightKg, "weightKg", 1, false);
  if (weightKgInput !== undefined) return weightKgInput;

  const useGoalWeight = String(req.body.useGoalWeight || "false").toLowerCase() === "true";
  const profileWeight = useGoalWeight ? toKg(req.user.goalWeight) : toKg(req.user.weightCurrent);

  if (profileWeight && profileWeight > 0) {
    return profileWeight;
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
    const nutrientId = String(nutrient.nutrientId || "").toLowerCase();
    const nutrientNumber = String(nutrient.nutrientNumber || "").toLowerCase();
    const nutrientName = String(nutrient.nutrientName || "").toLowerCase();
    if (aliasSet.has(nutrientId) || aliasSet.has(nutrientNumber) || aliasSet.has(nutrientName)) {
      const value = Number(nutrient.value);
      if (Number.isFinite(value)) return value;
    }
  }

  return null;
};

const mapFoodSummary = (food) => {
  const foodNutrients = Array.isArray(food.foodNutrients) ? food.foodNutrients : [];

  return {
    fdcId: food.fdcId,
    description: food.description || "",
    dataType: food.dataType || "",
    brandName: food.brandName || "",
    brandOwner: food.brandOwner || "",
    foodCategory: food.foodCategory || "",
    servingSize: food.servingSize ?? null,
    servingSizeUnit: food.servingSizeUnit || "",
    nutrients: {
      caloriesKcal: findNutrientValue(foodNutrients, NUTRIENT_KEYS.caloriesKcal),
      proteinG: findNutrientValue(foodNutrients, NUTRIENT_KEYS.proteinG),
      carbsG: findNutrientValue(foodNutrients, NUTRIENT_KEYS.carbsG),
      fatG: findNutrientValue(foodNutrients, NUTRIENT_KEYS.fatG),
      fiberG: findNutrientValue(foodNutrients, NUTRIENT_KEYS.fiberG),
      sugarG: findNutrientValue(foodNutrients, NUTRIENT_KEYS.sugarG),
    },
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

export const calculateMacroTargets = catchAsync(async (req, res) => {
  const weightKg = resolveWeightKg(req);
  const goal = parseGoal(req.body.goal);

  const proteinPerKg = parseNumber(req.body.proteinPerKg, "proteinPerKg", 0, false) ?? DEFAULT_MACRO_PER_KG.protein;
  const carbsPerKg = parseNumber(req.body.carbsPerKg, "carbsPerKg", 0, false) ?? DEFAULT_MACRO_PER_KG.carbs;
  const fatPerKg = parseNumber(req.body.fatPerKg, "fatPerKg", 0, false) ?? DEFAULT_MACRO_PER_KG.fat;

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

  const caloriesPerKg = parseNumber(req.body.caloriesPerKg, "caloriesPerKg", 1, false);
  const recommendedCalories =
    caloriesPerKg !== undefined
      ? round(weightKg * caloriesPerKg, 0)
      : round(weightKg * ((goalRange.min + goalRange.max) / 2), 0);

  const remainingCalories = round(recommendedCalories - macroCalories, 1);

  res.status(httpStatus.OK).json({
    success: true,
    data: {
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
