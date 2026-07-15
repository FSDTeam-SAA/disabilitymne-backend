import mongoose from "mongoose";
import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { isPremiumActiveUser } from "../utils/access.js";
import { toMediaUrl, toMediaUrlList } from "../utils/mediaResponse.js";
import { NutritionPlan, MEAL_TYPES, NUTRITION_DAY_INDEXES } from "../models/nutritionPlan.model.js";
import { Recipe } from "../models/recipe.model.js";
import { User } from "../models/user.model.js";
import { getPlanKeyVariants } from "../constants/subscriptionPlans.js";

const PREMIUM_PLAN_KEYS = getPlanKeyVariants("premium");
const PLAN_STATUSES = new Set(["draft", "published", "archived"]);
const WEEKDAY_LABELS = {
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
  7: "Sun",
};

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const parseMaybeJson = (value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
};

const getField = (body, keys) => {
  for (const key of keys) {
    if (Object.hasOwn(body, key)) {
      return { provided: true, value: body[key] };
    }
  }
  return { provided: false, value: undefined };
};

const parsePage = (value) => {
  const page = Number(value || 1);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
};

const parseLimit = (value, defaultValue = 10, maxValue = 100) => {
  const limit = Number(value || defaultValue);
  if (!Number.isFinite(limit) || limit <= 0) return defaultValue;
  return Math.min(Math.floor(limit), maxValue);
};

const buildPagination = (page, limit, total) => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});

const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseObjectId = (value, fieldName) => {
  const id = asString(value);
  if (!id) return null;
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(`${fieldName} must be a valid id.`, httpStatus.BAD_REQUEST);
  }
  return id;
};

const normalizePlanStatus = (value) => {
  const status = asString(value).toLowerCase();
  if (!PLAN_STATUSES.has(status)) {
    throw new AppError("status must be one of: draft, published, archived.", httpStatus.BAD_REQUEST);
  }
  return status;
};

const normalizeMealType = (value) => {
  const mealType = asString(value).toLowerCase() || "meal";
  if (!MEAL_TYPES.includes(mealType)) {
    throw new AppError(
      `mealType must be one of: ${MEAL_TYPES.join(", ")}.`,
      httpStatus.BAD_REQUEST
    );
  }
  return mealType;
};

const ensurePremiumUserAssignable = async (userId) => {
  const parsedId = parseObjectId(userId, "assignedUser");
  if (!parsedId) {
    throw new AppError("assignedUser is required for nutrition plans.", httpStatus.BAD_REQUEST);
  }

  const user = await User.findById(parsedId).select(
    "firstName email role selectedPlan subscriptionStatus subscriptionEndsAt isActive"
  );
  if (!user || !user.isActive) {
    throw new AppError("Assigned user was not found.", httpStatus.NOT_FOUND);
  }

  if (user.role === "admin") {
    throw new AppError("Assigned user must be a regular user account.", httpStatus.BAD_REQUEST);
  }

  if (!isPremiumActiveUser(user)) {
    throw new AppError(
      "Assigned user must have an active premium subscription before receiving a nutrition plan.",
      httpStatus.BAD_REQUEST
    );
  }

  return user;
};

const parseNutritionDays = (rawValue) => {
  const parsed = parseMaybeJson(rawValue);
  if (!Array.isArray(parsed)) {
    throw new AppError("nutritionDays must be an array.", httpStatus.BAD_REQUEST);
  }

  return parsed.map((day, dayOffset) => {
    const dayIndex = Number(day?.dayIndex ?? day?.day ?? dayOffset + 1);
    if (!NUTRITION_DAY_INDEXES.includes(dayIndex)) {
      throw new AppError("dayIndex must be between 1 and 7.", httpStatus.BAD_REQUEST);
    }

    const mealsRaw = Array.isArray(day?.meals) ? day.meals : [];
    const meals = mealsRaw.map((meal, mealIndex) => {
      const recipeId = parseObjectId(
        meal?.recipe || meal?.recipeId || meal?.id,
        "recipe"
      );
      if (!recipeId) {
        throw new AppError("Each meal requires a recipe id.", httpStatus.BAD_REQUEST);
      }

      return {
        recipe: recipeId,
        mealType: normalizeMealType(meal?.mealType || meal?.type || meal?.recipeType),
        order: Number(meal?.order) > 0 ? Number(meal.order) : mealIndex + 1,
        notes: asString(meal?.notes),
      };
    });

    return {
      dayIndex,
      label: asString(day?.label) || WEEKDAY_LABELS[dayIndex] || "",
      meals,
    };
  });
};

const validateRecipesExist = async (recipeIds) => {
  const uniqueIds = [...new Set(recipeIds.map(String))];
  if (uniqueIds.length === 0) return;

  const count = await Recipe.countDocuments({
    _id: { $in: uniqueIds },
    isActive: true,
  });

  if (count !== uniqueIds.length) {
    throw new AppError("One or more recipes were not found.", httpStatus.BAD_REQUEST);
  }
};

const buildRecipeCard = (recipe) => {
  if (!recipe) return null;
  const doc = recipe._id ? recipe : null;
  if (!doc) {
    return { id: recipe };
  }

  return {
    id: doc._id,
    recipeName: doc.recipeName,
    recipeDuration: doc.recipeDuration,
    durationMinutes: doc.durationMinutes,
    recipeType: doc.recipeType,
    caloriesKcal: doc.caloriesKcal,
    proteinG: doc.proteinG,
    carbsG: doc.carbsG,
    fatG: doc.fatG,
    recipeImage: toMediaUrl(doc.recipeImages?.[0]),
    recipeImages: toMediaUrlList(doc.recipeImages),
    howToPrepare: doc.howToPrepare || "",
    ingredients: doc.ingredients || [],
  };
};

const buildPlanSummary = (plan) => {
  const assignedUser =
    plan.assignedUser && typeof plan.assignedUser === "object" && plan.assignedUser._id
      ? {
          id: plan.assignedUser._id,
          firstName: plan.assignedUser.firstName,
          email: plan.assignedUser.email,
        }
      : plan.assignedUser || null;

  return {
    id: plan._id,
    title: plan.title,
    description: plan.description || "",
    assignedUser,
    status: plan.status,
    isActive: plan.isActive,
    dayCount: Array.isArray(plan.nutritionDays) ? plan.nutritionDays.length : 0,
    mealCount: Array.isArray(plan.nutritionDays)
      ? plan.nutritionDays.reduce((sum, day) => sum + (day.meals?.length || 0), 0)
      : 0,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
};

const buildPlanDetails = (plan) => ({
  ...buildPlanSummary(plan),
  nutritionDays: (plan.nutritionDays || []).map((day) => ({
    dayIndex: day.dayIndex,
    label: day.label || WEEKDAY_LABELS[day.dayIndex] || "",
    meals: (day.meals || [])
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((meal) => ({
        id: meal._id,
        mealType: meal.mealType,
        order: meal.order,
        notes: meal.notes || "",
        recipe: buildRecipeCard(meal.recipe),
      })),
  })),
});

const populatePlanQuery = (query) =>
  query
    .populate("assignedUser", "firstName email")
    .populate({
      path: "nutritionDays.meals.recipe",
      select:
        "recipeName recipeDuration durationMinutes recipeType caloriesKcal proteinG carbsG fatG recipeImages howToPrepare ingredients isActive status",
    });

const buildCreatePayload = async (body, adminId) => {
  const title = asString(body.title || body.name || body.planName);
  if (!title) {
    throw new AppError("title is required.", httpStatus.BAD_REQUEST);
  }

  const assignedUser = await ensurePremiumUserAssignable(
    body.assignedUser || body.userId || body.assignedUserId
  );

  const nutritionDaysInput = getField(body, ["nutritionDays", "days", "mealDays"]);
  const nutritionDays = nutritionDaysInput.provided ? parseNutritionDays(nutritionDaysInput.value) : [];

  const recipeIds = nutritionDays.flatMap((day) => day.meals.map((meal) => meal.recipe));
  await validateRecipesExist(recipeIds);

  const statusInput = getField(body, ["status"]);
  const status = statusInput.provided ? normalizePlanStatus(statusInput.value) : "published";

  return {
    title,
    description: asString(body.description),
    assignedUser: assignedUser._id,
    status,
    isActive: status !== "archived",
    nutritionDays,
    createdBy: adminId,
    updatedBy: adminId,
  };
};

const buildUpdatePayload = async (body, existing) => {
  const updates = {};

  const titleInput = getField(body, ["title", "name", "planName"]);
  if (titleInput.provided) {
    const title = asString(titleInput.value);
    if (!title) throw new AppError("title cannot be empty.", httpStatus.BAD_REQUEST);
    updates.title = title;
  }

  const descriptionInput = getField(body, ["description"]);
  if (descriptionInput.provided) {
    updates.description = asString(descriptionInput.value);
  }

  const assignedInput = getField(body, ["assignedUser", "userId", "assignedUserId"]);
  if (assignedInput.provided) {
    const premiumUser = await ensurePremiumUserAssignable(assignedInput.value);
    updates.assignedUser = premiumUser._id;
  }

  const daysInput = getField(body, ["nutritionDays", "days", "mealDays"]);
  if (daysInput.provided) {
    const nutritionDays = parseNutritionDays(daysInput.value);
    const recipeIds = nutritionDays.flatMap((day) => day.meals.map((meal) => meal.recipe));
    await validateRecipesExist(recipeIds);
    updates.nutritionDays = nutritionDays;
  }

  const statusInput = getField(body, ["status"]);
  if (statusInput.provided) {
    const status = normalizePlanStatus(statusInput.value);
    updates.status = status;
    updates.isActive = status !== "archived";
  }

  const isActiveInput = getField(body, ["isActive"]);
  if (isActiveInput.provided) {
    updates.isActive = Boolean(isActiveInput.value === true || isActiveInput.value === "true");
  }

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields were provided for update.", httpStatus.BAD_REQUEST);
  }

  updates.updatedBy = existing.updatedBy;
  return updates;
};

export const listPremiumUsersForNutritionPlans = catchAsync(async (req, res) => {
  const search = asString(req.query.search);
  const now = new Date();
  const query = {
    role: "user",
    isActive: true,
    selectedPlan: { $in: PREMIUM_PLAN_KEYS },
    subscriptionStatus: "active",
    $or: [{ subscriptionEndsAt: null }, { subscriptionEndsAt: { $gt: now } }],
  };

  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    query.$and = [{ $or: [{ firstName: pattern }, { email: pattern }] }];
  }

  const users = await User.find(query)
    .sort({ firstName: 1, email: 1 })
    .limit(100)
    .select("firstName email selectedPlan subscriptionStatus");

  res.status(httpStatus.OK).json({
    success: true,
    data: users.map((user) => ({
      id: user._id,
      firstName: user.firstName,
      email: user.email,
      selectedPlan: user.selectedPlan,
      subscriptionStatus: user.subscriptionStatus,
    })),
  });
});

export const createNutritionPlan = catchAsync(async (req, res) => {
  const payload = await buildCreatePayload(req.body, req.user._id);
  const plan = await NutritionPlan.create(payload);
  const populated = await populatePlanQuery(NutritionPlan.findById(plan._id));

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Nutrition plan created successfully.",
    data: buildPlanDetails(populated),
  });
});

export const getAdminNutritionPlans = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;
  const filter = {};

  if (req.query.assignedUser) {
    filter.assignedUser = parseObjectId(req.query.assignedUser, "assignedUser");
  }
  if (req.query.status) {
    filter.status = normalizePlanStatus(req.query.status);
  }
  if (Object.hasOwn(req.query, "isActive")) {
    filter.isActive = req.query.isActive === true || req.query.isActive === "true";
  }
  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.$or = [{ title: pattern }, { description: pattern }];
  }

  const [plans, total] = await Promise.all([
    populatePlanQuery(NutritionPlan.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit)),
    NutritionPlan.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: plans.map(buildPlanSummary),
    meta: buildPagination(page, limit, total),
  });
});

export const getAdminNutritionPlanById = catchAsync(async (req, res) => {
  const { planId } = req.params;
  if (!mongoose.isValidObjectId(planId)) {
    throw new AppError("Invalid nutrition plan id.", httpStatus.BAD_REQUEST);
  }

  const plan = await populatePlanQuery(NutritionPlan.findById(planId));
  if (!plan) {
    throw new AppError("Nutrition plan not found.", httpStatus.NOT_FOUND);
  }

  res.status(httpStatus.OK).json({
    success: true,
    data: buildPlanDetails(plan),
  });
});

export const updateAdminNutritionPlan = catchAsync(async (req, res) => {
  const { planId } = req.params;
  if (!mongoose.isValidObjectId(planId)) {
    throw new AppError("Invalid nutrition plan id.", httpStatus.BAD_REQUEST);
  }

  const plan = await NutritionPlan.findById(planId);
  if (!plan) {
    throw new AppError("Nutrition plan not found.", httpStatus.NOT_FOUND);
  }

  const updates = await buildUpdatePayload(req.body, plan);
  updates.updatedBy = req.user._id;
  Object.assign(plan, updates);
  await plan.save();

  const populated = await populatePlanQuery(NutritionPlan.findById(plan._id));

  res.status(httpStatus.OK).json({
    success: true,
    message: "Nutrition plan updated successfully.",
    data: buildPlanDetails(populated),
  });
});

export const deleteAdminNutritionPlan = catchAsync(async (req, res) => {
  const { planId } = req.params;
  if (!mongoose.isValidObjectId(planId)) {
    throw new AppError("Invalid nutrition plan id.", httpStatus.BAD_REQUEST);
  }

  const plan = await NutritionPlan.findById(planId);
  if (!plan) {
    throw new AppError("Nutrition plan not found.", httpStatus.NOT_FOUND);
  }

  plan.isActive = false;
  plan.status = "archived";
  plan.updatedBy = req.user._id;
  await plan.save();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Nutrition plan deleted successfully.",
  });
});

export const getMyNutritionPlans = catchAsync(async (req, res) => {
  if (!isPremiumActiveUser(req.user)) {
    return res.status(httpStatus.OK).json({
      success: true,
      data: [],
      meta: buildPagination(1, 20, 0),
    });
  }

  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = {
    assignedUser: req.user._id,
    status: "published",
    isActive: true,
  };

  const [plans, total] = await Promise.all([
    populatePlanQuery(NutritionPlan.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit)),
    NutritionPlan.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: plans.map(buildPlanDetails),
    meta: buildPagination(page, limit, total),
  });
});

export const getNutritionPlanByIdForUser = catchAsync(async (req, res) => {
  const { planId } = req.params;
  if (!mongoose.isValidObjectId(planId)) {
    throw new AppError("Invalid nutrition plan id.", httpStatus.BAD_REQUEST);
  }

  const plan = await populatePlanQuery(NutritionPlan.findById(planId));
  if (!plan || !plan.isActive) {
    throw new AppError("Nutrition plan not found.", httpStatus.NOT_FOUND);
  }

  if (req.user.role === "admin") {
    return res.status(httpStatus.OK).json({
      success: true,
      data: buildPlanDetails(plan),
    });
  }

  if (
    !isPremiumActiveUser(req.user) ||
    plan.status !== "published" ||
    String(plan.assignedUser?._id || plan.assignedUser) !== String(req.user._id)
  ) {
    throw new AppError("You are not allowed to access this nutrition plan.", httpStatus.FORBIDDEN);
  }

  return res.status(httpStatus.OK).json({
    success: true,
    data: buildPlanDetails(plan),
  });
});
