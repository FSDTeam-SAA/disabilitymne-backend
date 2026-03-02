import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { NutritionEntry } from "../models/nutritionEntry.model.js";

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

const toNutritionEntryResponse = (entry) => ({
  id: entry._id,
  entryDate: entry.entryDate,
  mealType: entry.mealType,
  mealLabel: DIARY_MEAL_LABELS[entry.mealType] || entry.mealType,
  foodName: entry.foodName,
  brandName: entry.brandName || "",
  source: entry.source,
  fdcId: entry.fdcId || null,
  quantity: entry.quantity,
  servingLabel: entry.servingLabel,
  totalGrams: round(Number(entry.totalGrams || 0), 1),
  caloriesKcal: round(Number(entry.caloriesKcal || 0), 1),
  proteinG: round(Number(entry.proteinG || 0), 1),
  carbsG: round(Number(entry.carbsG || 0), 1),
  fatG: round(Number(entry.fatG || 0), 1),
  fiberG: round(Number(entry.fiberG || 0), 1),
  sugarG: round(Number(entry.sugarG || 0), 1),
  imageUrl: entry.imageUrl || "",
  notes: entry.notes || "",
  isFavorite: Boolean(entry.isFavorite),
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
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

const buildNutritionDiaryResponse = (date, entries) => {
  const totals = buildNutritionTotals(entries);
  const meals = DIARY_MEAL_TYPES.map((mealType) => {
    const mealEntries = entries.filter((entry) => entry.mealType === mealType);
    return {
      mealType,
      mealLabel: DIARY_MEAL_LABELS[mealType],
      totalEntries: mealEntries.length,
      totals: buildNutritionTotals(mealEntries),
      entries: mealEntries.map(toNutritionEntryResponse),
    };
  });

  return {
    date,
    totals,
    macroPercentages: buildMacroPercentages(totals),
    totalEntries: entries.length,
    meals,
    entries: entries.map(toNutritionEntryResponse),
  };
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

export const getNutritionDiary = catchAsync(async (req, res) => {
  const entryDate = normalizeDiaryDate(req.query.date || req.query.entryDate);
  const entries = await NutritionEntry.find({
    user: req.user._id,
    entryDate,
  }).sort({ mealType: 1, createdAt: 1 });

  res.status(httpStatus.OK).json({
    success: true,
    data: buildNutritionDiaryResponse(entryDate, entries),
  });
});

export const getNutritionFavorites = catchAsync(async (req, res) => {
  const limit = parseNumber(req.query.limit, "limit", 1, false) ?? 20;
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const entries = await NutritionEntry.find({
    user: req.user._id,
    isFavorite: true,
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(safeLimit);

  res.status(httpStatus.OK).json({
    success: true,
    data: entries.map(toNutritionEntryResponse),
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
