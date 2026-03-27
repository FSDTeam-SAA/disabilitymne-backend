import mongoose from "mongoose";
import httpStatus from "http-status";
import fs from "node:fs/promises";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { isPremiumActiveUser } from "../utils/access.js";
import { toMediaUrl, toMediaUrlList } from "../utils/mediaResponse.js";
import { mergeUploadedMediaIntoBody } from "../utils/uploadedMedia.js";
import {
  deleteCloudinaryMediaByPublicId,
  uploadMediaFileToCloudinary,
  uploadMediaUrlToCloudinary,
} from "../services/cloudinary.service.js";
import { Recipe } from "../models/recipe.model.js";
import { User } from "../models/user.model.js";

const RECIPE_USER_TYPES = new Set(["normal_user", "premium_user"]);
const RECIPE_STATUSES = new Set(["draft", "published", "archived"]);
const RECIPE_IMAGE_FIELDS = ["recipeImages", "recipeImage", "image"];
const CLOUDINARY_RECIPE_IMAGE_FOLDER = "recipes/images";

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

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const normalizeUploadedFiles = (files) => {
  if (!files) return {};

  if (Array.isArray(files)) {
    return files.reduce((acc, file) => {
      const fieldName = asString(file?.fieldname);
      if (!fieldName) return acc;

      if (!acc[fieldName]) {
        acc[fieldName] = [];
      }

      acc[fieldName].push(file);
      return acc;
    }, {});
  }

  return files;
};

const getUploadedFilesByFieldNames = (files, fieldNames = []) => {
  const groupedFiles = normalizeUploadedFiles(files);
  const uploadedFiles = [];

  for (const fieldName of fieldNames) {
    const fieldFiles = groupedFiles[fieldName];
    if (Array.isArray(fieldFiles) && fieldFiles.length > 0) {
      uploadedFiles.push(...fieldFiles);
    }
  }

  return uploadedFiles;
};

const cleanupTemporaryUpload = async (file) => {
  const filePath = asString(file?.path);
  if (!filePath) return;

  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore cleanup errors for temporary upload files.
  }
};

const cleanupTemporaryUploads = async (files = []) => {
  await Promise.all(files.map((file) => cleanupTemporaryUpload(file)));
};

const uploadImagesToCloudinary = async (files, folder, failureMessage) => {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  try {
    return await Promise.all(
      files.map((file) =>
        uploadMediaFileToCloudinary(file, {
          folder,
          resourceType: "image",
        })
      )
    );
  } catch (error) {
    throw new AppError(asString(error?.message) || failureMessage, httpStatus.INTERNAL_SERVER_ERROR);
  } finally {
    await cleanupTemporaryUploads(files);
  }
};

const escapeRegex = (input) => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseObjectId = (value, fieldName) => {
  const id = asString(value);
  if (!id) return null;

  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(`${fieldName} must be a valid id.`, httpStatus.BAD_REQUEST);
  }

  return id;
};

const parseBoolean = (value, fieldName) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;

  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase().trim();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  throw new AppError(`${fieldName} must be a boolean.`, httpStatus.BAD_REQUEST);
};

const parseNumber = (value, fieldName, min = 0, required = false) => {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new AppError(`${fieldName} is required.`, httpStatus.BAD_REQUEST);
    }
    return undefined;
  }

  let numeric = value;
  if (typeof value === "string") {
    const matched = value.match(/-?\d+(\.\d+)?/);
    if (!matched) {
      throw new AppError(`${fieldName} must be numeric.`, httpStatus.BAD_REQUEST);
    }
    numeric = matched[0];
  }

  const parsed = Number(numeric);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new AppError(`${fieldName} must be a number >= ${min}.`, httpStatus.BAD_REQUEST);
  }

  return parsed;
};

const parseDurationMinutes = (value, durationLabel) => {
  const direct = parseNumber(value, "durationMinutes", 1, false);
  if (direct !== undefined) return Math.round(direct);

  const label = asString(durationLabel);
  const matched = label.match(/\d+/);
  if (matched) {
    return Math.max(1, Number(matched[0]));
  }

  throw new AppError(
    "durationMinutes is required (or provide a parseable number in recipeDuration).",
    httpStatus.BAD_REQUEST
  );
};

const normalizeUserType = (value) => {
  const cleaned = asString(value).toLowerCase().replace(/\s+/g, "_");
  if (!cleaned || cleaned === "normal") return "normal_user";
  if (cleaned === "premium") return "premium_user";

  if (!RECIPE_USER_TYPES.has(cleaned)) {
    throw new AppError("userType must be either normal_user or premium_user.", httpStatus.BAD_REQUEST);
  }

  return cleaned;
};

const normalizeRecipeType = (value) => {
  const cleaned = asString(value).toLowerCase().replace(/\s+/g, "");
  if (!cleaned) return "breakfast";

  if (cleaned === "breakfast" || cleaned === "breakfasts" || cleaned === "breakfastmeal" || cleaned === "breakfastsmeal") {
    return "breakfast";
  }
  if (cleaned === "lunch") return "lunch";
  if (cleaned === "dinner") return "dinner";
  if (cleaned === "snack" || cleaned === "snacks") return "snack";
  if (cleaned === "meal") return "meal";
  if (cleaned === "other") return "other";

  throw new AppError("recipeType must be one of: breakfast, lunch, dinner, snack, meal, other.", httpStatus.BAD_REQUEST);
};

const normalizeRecipeStatus = (value) => {
  const normalized = asString(value).toLowerCase();
  if (!RECIPE_STATUSES.has(normalized)) {
    throw new AppError("status must be one of: draft, published, archived.", httpStatus.BAD_REQUEST);
  }

  return normalized;
};

const normalizeMediaAsset = (rawValue) => {
  const value = parseMaybeJson(rawValue);
  if (!value) return null;

  if (typeof value === "string") {
    const url = value.trim();
    if (!url) return null;
    return {
      url,
      publicId: "",
      mimetype: "",
      size: 0,
    };
  }

  if (typeof value !== "object") return null;

  const url = asString(value.url || value.path || value.secure_url);
  if (!url) return null;

  const size = Number(value.size);

  return {
    url,
    publicId: asString(value.publicId || value.public_id || value.filename),
    mimetype: asString(value.mimetype || value.resource_type || value.format),
    size: Number.isFinite(size) && size > 0 ? size : 0,
  };
};

const normalizeMediaList = (rawValue) => {
  const value = parseMaybeJson(rawValue);
  if (value === undefined || value === null || value === "") return [];

  if (Array.isArray(value)) return value.map(normalizeMediaAsset).filter(Boolean);

  const single = normalizeMediaAsset(value);
  return single ? [single] : [];
};

const extractCloudinaryMediaInfoFromUrl = (url) => {
  const rawUrl = asString(url);
  if (!rawUrl || !/res\.cloudinary\.com/i.test(rawUrl)) {
    return { publicId: "", resourceType: "image" };
  }

  try {
    const parsed = new URL(rawUrl);
    const markerMatch = parsed.pathname.match(/\/(image|video)\/upload\//i);
    if (!markerMatch || !markerMatch[0]) {
      return { publicId: "", resourceType: "image" };
    }

    const resourceType = markerMatch[1]?.toLowerCase() === "video" ? "video" : "image";
    const marker = markerMatch[0];
    let publicIdPath = parsed.pathname.slice(parsed.pathname.indexOf(marker) + marker.length);

    publicIdPath = publicIdPath.replace(/^v\d+\//, "");
    publicIdPath = publicIdPath.replace(/\.[^/.]+$/, "");

    return {
      publicId: decodeURIComponent(publicIdPath),
      resourceType,
    };
  } catch {
    return { publicId: "", resourceType: "image" };
  }
};

const getMediaAssetCloudinaryInfo = (asset) => {
  const url = asString(asset?.url);
  const parsedFromUrl = extractCloudinaryMediaInfoFromUrl(url);

  return {
    publicId: asString(asset?.publicId) || parsedFromUrl.publicId,
    resourceType: "image",
  };
};

const buildMediaAssetComparisonKey = (asset) => {
  const cloudinaryInfo = getMediaAssetCloudinaryInfo(asset);
  if (cloudinaryInfo.publicId) {
    return `public:${cloudinaryInfo.resourceType}:${cloudinaryInfo.publicId}`;
  }

  const url = asString(asset?.url);
  if (url) {
    return `url:${url}`;
  }

  return "";
};

const preserveExistingMediaMetadata = (nextAssets, existingAssets) => {
  const normalizedNext = normalizeMediaList(nextAssets);
  const normalizedExisting = normalizeMediaList(existingAssets);

  const existingByUrl = new Map(
    normalizedExisting
      .map((asset) => [asString(asset.url), asset])
      .filter(([url]) => Boolean(url))
  );

  return normalizedNext.map((asset) => {
    const url = asString(asset.url);
    const matchedExisting = existingByUrl.get(url);
    const size = Number(asset.size);

    if (!matchedExisting) {
      return asset;
    }

    const existingSize = Number(matchedExisting.size);

    return {
      url,
      publicId: asString(asset.publicId || matchedExisting.publicId),
      mimetype: asString(asset.mimetype || matchedExisting.mimetype),
      size:
        Number.isFinite(size) && size > 0
          ? size
          : Number.isFinite(existingSize) && existingSize > 0
            ? existingSize
            : 0,
    };
  });
};

const resolveRemovedCloudinaryAssets = (previousAssets, nextAssets) => {
  const previous = normalizeMediaList(previousAssets);
  const next = normalizeMediaList(nextAssets);
  const nextKeys = new Set(next.map((asset) => buildMediaAssetComparisonKey(asset)).filter(Boolean));
  const removedAssets = [];

  for (const previousAsset of previous) {
    const key = buildMediaAssetComparisonKey(previousAsset);
    if (!key || nextKeys.has(key)) {
      continue;
    }

    const cloudinaryInfo = getMediaAssetCloudinaryInfo(previousAsset);
    if (cloudinaryInfo.publicId) {
      removedAssets.push(cloudinaryInfo);
    }
  }

  return removedAssets;
};

const deleteCloudinaryAssets = async (assets = []) => {
  const uniqueAssets = [];
  const seen = new Set();

  for (const asset of assets) {
    const publicId = asString(asset?.publicId);
    const resourceType = asString(asset?.resourceType).toLowerCase() === "video" ? "video" : "image";
    if (!publicId) continue;

    const key = `${resourceType}:${publicId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    uniqueAssets.push({ publicId, resourceType });
  }

  if (uniqueAssets.length === 0) {
    return;
  }

  await Promise.allSettled(
    uniqueAssets.map((asset) =>
      deleteCloudinaryMediaByPublicId(asset.publicId, {
        resourceType: asset.resourceType,
      })
    )
  );
};

const isAbsoluteHttpUrl = (value) => /^https?:\/\//i.test(asString(value));

const convertMediaAssetsToCloudinaryIfNeeded = async (rawValue, options = {}) => {
  const assets = normalizeMediaList(rawValue);
  if (assets.length === 0) {
    return assets;
  }

  const folder = asString(options.folder);
  const failureMessage = asString(options.failureMessage) || "Failed to upload media URL to Cloudinary.";

  try {
    const converted = await Promise.all(
      assets.map(async (asset) => {
        const cloudinaryInfo = getMediaAssetCloudinaryInfo(asset);
        if (cloudinaryInfo.publicId || /res\.cloudinary\.com/i.test(asString(asset?.url))) {
          return asset;
        }

        const sourceUrl = asString(asset?.url);
        if (!isAbsoluteHttpUrl(sourceUrl)) {
          return asset;
        }

        return uploadMediaUrlToCloudinary(sourceUrl, {
          folder,
          resourceType: "image",
        });
      })
    );

    return converted;
  } catch (error) {
    throw new AppError(asString(error?.message) || failureMessage, httpStatus.INTERNAL_SERVER_ERROR);
  }
};

const normalizeIngredients = (rawValue) => {
  const value = parseMaybeJson(rawValue);
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.map((item) => asString(item)).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
};

const ensurePremiumUserAssignable = async (userId) => {
  const parsedId = parseObjectId(userId, "assignedUser");
  if (!parsedId) {
    throw new AppError("assignedUser is required for premium_user recipes.", httpStatus.BAD_REQUEST);
  }

  const user = await User.findById(parsedId).select("firstName email role selectedPlan subscriptionStatus isActive");
  if (!user || !user.isActive) {
    throw new AppError("Assigned user was not found.", httpStatus.NOT_FOUND);
  }

  if (user.role === "admin") {
    throw new AppError("Assigned user must be a regular user account.", httpStatus.BAD_REQUEST);
  }

  if (!isPremiumActiveUser(user)) {
    throw new AppError(
      "Assigned user must have an active premium subscription before receiving private recipes.",
      httpStatus.BAD_REQUEST
    );
  }

  return user;
};

const getFavoriteRecipeIdSet = (user) =>
  new Set(
    (user?.favoriteRecipeRefs || [])
      .map((item) => String(item?.recipe || item))
      .filter(Boolean)
  );

const isRecipeAccessibleToUser = (recipe, user) => {
  if (!recipe || !recipe.isActive) return false;
  if (user?.role === "admin") return true;
  if (recipe.status !== "published") return false;
  if (recipe.userType === "normal_user") return true;

  return (
    isPremiumActiveUser(user) &&
    recipe.userType === "premium_user" &&
    recipe.assignedUser &&
    String(recipe.assignedUser._id || recipe.assignedUser) === String(user._id)
  );
};

const buildRecipeSummary = (recipe, options = {}) => {
  const assignedUser = recipe.assignedUser && typeof recipe.assignedUser === "object" && recipe.assignedUser._id
    ? {
        id: recipe.assignedUser._id,
        firstName: recipe.assignedUser.firstName,
        email: recipe.assignedUser.email,
      }
    : recipe.assignedUser || null;

  return {
    id: recipe._id,
    recipeName: recipe.recipeName,
    recipeDuration: recipe.recipeDuration,
    durationMinutes: recipe.durationMinutes,
    recipeType: recipe.recipeType,
    userType: recipe.userType,
    assignedUser,
    caloriesKcal: recipe.caloriesKcal,
    proteinG: recipe.proteinG,
    carbsG: recipe.carbsG,
    fatG: recipe.fatG,
    nutritionSummary: `${recipe.caloriesKcal}kcal, ${recipe.proteinG}gprotein, ${recipe.carbsG}gcarbs, ${recipe.fatG}gfat`,
    recipeImage: toMediaUrl(recipe.recipeImages?.[0]),
    recipeImages: toMediaUrlList(recipe.recipeImages),
    status: recipe.status,
    isActive: recipe.isActive,
    isFavorite: Boolean(options.isFavorite),
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
  };
};

const buildRecipeDetails = (recipe, options = {}) => ({
  ...buildRecipeSummary(recipe, options),
  howToPrepare: recipe.howToPrepare || "",
  ingredients: recipe.ingredients || [],
});

const buildPagination = (page, limit, total) => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});

const parsePage = (value) => {
  const page = Number(value || 1);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
};

const parseLimit = (value, defaultValue = 10, maxValue = 100) => {
  const limit = Number(value || defaultValue);
  if (!Number.isFinite(limit) || limit <= 0) return defaultValue;
  return Math.min(Math.floor(limit), maxValue);
};

const buildCreatePayload = async (body) => {
  const parsedBody = body || {};

  const recipeName = asString(getField(parsedBody, ["recipeName", "name"]).value);
  if (!recipeName) {
    throw new AppError("recipeName is required.", httpStatus.BAD_REQUEST);
  }

  const userType = normalizeUserType(getField(parsedBody, ["userType"]).value || "normal_user");
  const recipeType = normalizeRecipeType(getField(parsedBody, ["recipeType", "type"]).value || "breakfast");

  const rawDurationLabel = getField(parsedBody, ["recipeDuration", "duration"]).value;
  let recipeDuration = asString(rawDurationLabel);
  const durationMinutes = parseDurationMinutes(getField(parsedBody, ["durationMinutes"]).value, recipeDuration);
  if (!recipeDuration) {
    recipeDuration = `${durationMinutes} Minutes`;
  }

  const howToPrepare = asString(getField(parsedBody, ["howToPrepare", "description"]).value);
  const ingredients = normalizeIngredients(getField(parsedBody, ["ingredients"]).value);
  if (ingredients.length === 0) {
    throw new AppError("At least one ingredient is required.", httpStatus.BAD_REQUEST);
  }

  const recipeImages = normalizeMediaList(getField(parsedBody, ["recipeImages", "recipeImage", "image"]).value);
  if (recipeImages.length === 0) {
    throw new AppError("At least one recipe image is required.", httpStatus.BAD_REQUEST);
  }

  const caloriesKcal = parseNumber(
    getField(parsedBody, ["caloriesKcal", "calories"]).value,
    "caloriesKcal",
    0,
    true
  );
  const proteinG = parseNumber(getField(parsedBody, ["proteinG", "protein"]).value, "proteinG", 0, true);
  const carbsG = parseNumber(getField(parsedBody, ["carbsG", "carbs"]).value, "carbsG", 0, true);
  const fatG = parseNumber(getField(parsedBody, ["fatG", "fat"]).value, "fatG", 0, true);
  const status = normalizeRecipeStatus(getField(parsedBody, ["status"]).value || "published");

  let assignedUser = null;
  if (userType === "premium_user") {
    const assignedInput = getField(parsedBody, ["assignedUser", "assignedUserId", "targetUserId", "userId"]).value;
    const premiumUser = await ensurePremiumUserAssignable(assignedInput);
    assignedUser = premiumUser._id;
  }

  return {
    recipeName,
    recipeDuration,
    durationMinutes,
    recipeType,
    userType,
    assignedUser,
    howToPrepare,
    ingredients,
    recipeImages,
    caloriesKcal,
    proteinG,
    carbsG,
    fatG,
    status,
    isActive: status !== "archived",
  };
};

const buildUpdatePayload = async (body, currentRecipe) => {
  const parsedBody = body || {};
  const updates = {};

  const nameInput = getField(parsedBody, ["recipeName", "name"]);
  if (nameInput.provided) {
    const recipeName = asString(nameInput.value);
    if (!recipeName) {
      throw new AppError("recipeName cannot be empty.", httpStatus.BAD_REQUEST);
    }
    updates.recipeName = recipeName;
  }

  const durationLabelInput = getField(parsedBody, ["recipeDuration", "duration"]);
  const durationMinutesInput = getField(parsedBody, ["durationMinutes"]);
  if (durationLabelInput.provided) {
    const label = asString(durationLabelInput.value);
    if (!label) {
      throw new AppError("recipeDuration cannot be empty.", httpStatus.BAD_REQUEST);
    }
    updates.recipeDuration = label;
    if (!durationMinutesInput.provided) {
      const matched = label.match(/\d+/);
      if (matched) {
        updates.durationMinutes = Math.max(1, Number(matched[0]));
      }
    }
  }

  if (durationMinutesInput.provided) {
    const durationMinutes = parseDurationMinutes(durationMinutesInput.value, updates.recipeDuration || currentRecipe.recipeDuration);
    updates.durationMinutes = durationMinutes;
    if (!durationLabelInput.provided) {
      updates.recipeDuration = `${durationMinutes} Minutes`;
    }
  }

  const recipeTypeInput = getField(parsedBody, ["recipeType", "type"]);
  if (recipeTypeInput.provided) {
    updates.recipeType = normalizeRecipeType(recipeTypeInput.value);
  }

  const userTypeInput = getField(parsedBody, ["userType"]);
  const assignedUserInput = getField(parsedBody, ["assignedUser", "assignedUserId", "targetUserId", "userId"]);
  if (userTypeInput.provided || assignedUserInput.provided) {
    const nextUserType = userTypeInput.provided ? normalizeUserType(userTypeInput.value) : currentRecipe.userType;
    let nextAssignedUser = assignedUserInput.provided
      ? parseObjectId(assignedUserInput.value, "assignedUser")
      : currentRecipe.assignedUser?.toString() || null;

    if (nextUserType === "normal_user") {
      nextAssignedUser = null;
    } else {
      const premiumUser = await ensurePremiumUserAssignable(nextAssignedUser);
      nextAssignedUser = premiumUser._id;
    }

    updates.userType = nextUserType;
    updates.assignedUser = nextAssignedUser;
  }

  const prepInput = getField(parsedBody, ["howToPrepare", "description"]);
  if (prepInput.provided) {
    updates.howToPrepare = asString(prepInput.value);
  }

  const ingredientsInput = getField(parsedBody, ["ingredients"]);
  if (ingredientsInput.provided) {
    const ingredients = normalizeIngredients(ingredientsInput.value);
    if (ingredients.length === 0) {
      throw new AppError("At least one ingredient is required.", httpStatus.BAD_REQUEST);
    }
    updates.ingredients = ingredients;
  }

  const imageInput = getField(parsedBody, ["recipeImages", "recipeImage", "image"]);
  if (imageInput.provided) {
    const recipeImages = normalizeMediaList(imageInput.value);
    if (recipeImages.length === 0) {
      throw new AppError("At least one recipe image is required.", httpStatus.BAD_REQUEST);
    }
    updates.recipeImages = preserveExistingMediaMetadata(recipeImages, currentRecipe.recipeImages);
  }

  const caloriesInput = getField(parsedBody, ["caloriesKcal", "calories"]);
  if (caloriesInput.provided) {
    updates.caloriesKcal = parseNumber(caloriesInput.value, "caloriesKcal", 0, true);
  }

  const proteinInput = getField(parsedBody, ["proteinG", "protein"]);
  if (proteinInput.provided) {
    updates.proteinG = parseNumber(proteinInput.value, "proteinG", 0, true);
  }

  const carbsInput = getField(parsedBody, ["carbsG", "carbs"]);
  if (carbsInput.provided) {
    updates.carbsG = parseNumber(carbsInput.value, "carbsG", 0, true);
  }

  const fatInput = getField(parsedBody, ["fatG", "fat"]);
  if (fatInput.provided) {
    updates.fatG = parseNumber(fatInput.value, "fatG", 0, true);
  }

  const statusInput = getField(parsedBody, ["status"]);
  if (statusInput.provided) {
    const status = normalizeRecipeStatus(statusInput.value);
    updates.status = status;
    if (status === "archived") {
      updates.isActive = false;
    } else if (!Object.hasOwn(updates, "isActive")) {
      updates.isActive = true;
    }
  }

  const isActiveInput = getField(parsedBody, ["isActive"]);
  if (isActiveInput.provided) {
    updates.isActive = parseBoolean(isActiveInput.value, "isActive");
    if (updates.isActive === false) {
      updates.status = "archived";
    }
  }

  return updates;
};

const buildUserAccessibleFilter = (user) => {
  const filter = {
    status: "published",
    isActive: true,
    $or: [{ userType: "normal_user" }],
  };

  if (isPremiumActiveUser(user)) {
    filter.$or.push({ userType: "premium_user", assignedUser: user._id });
  }

  return filter;
};

const getRecipeBodyFromRequest = async (req) => {
  let payload = mergeUploadedMediaIntoBody(req.body, req.files, [{ target: "recipeImages", fieldNames: RECIPE_IMAGE_FIELDS }]);

  const recipeImageFiles = getUploadedFilesByFieldNames(req.files, RECIPE_IMAGE_FIELDS);
  if (recipeImageFiles.length > 0) {
    payload = {
      ...(payload || {}),
      recipeImages: await uploadImagesToCloudinary(
        recipeImageFiles,
        CLOUDINARY_RECIPE_IMAGE_FOLDER,
        "Failed to upload recipe images to Cloudinary."
      ),
    };
  }

  if (Object.hasOwn(payload, "recipeImages")) {
    payload = {
      ...(payload || {}),
      recipeImages: await convertMediaAssetsToCloudinaryIfNeeded(payload.recipeImages, {
        folder: CLOUDINARY_RECIPE_IMAGE_FOLDER,
        failureMessage: "Failed to migrate recipe images to Cloudinary.",
      }),
    };
  }

  return payload;
};

export const createRecipe = catchAsync(async (req, res) => {
  const payload = await buildCreatePayload(await getRecipeBodyFromRequest(req));

  const recipe = await Recipe.create({
    ...payload,
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });

  const populated = await Recipe.findById(recipe._id).populate("assignedUser", "firstName email");

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Recipe created successfully.",
    data: buildRecipeDetails(populated),
  });
});

export const getAdminRecipes = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = {};
  if (!Object.hasOwn(req.query, "isActive") && !req.query.status) {
    filter.isActive = true;
  }

  if (req.query.userType) {
    filter.userType = normalizeUserType(req.query.userType);
  }

  if (req.query.recipeType) {
    filter.recipeType = normalizeRecipeType(req.query.recipeType);
  }

  if (req.query.status) {
    filter.status = normalizeRecipeStatus(req.query.status);
  }

  if (Object.hasOwn(req.query, "isActive")) {
    filter.isActive = parseBoolean(req.query.isActive, "isActive");
  }

  if (req.query.assignedUser) {
    filter.assignedUser = parseObjectId(req.query.assignedUser, "assignedUser");
  }

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.$or = [{ recipeName: pattern }, { howToPrepare: pattern }, { ingredients: { $elemMatch: pattern } }];
  }

  const [recipes, total] = await Promise.all([
    Recipe.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("assignedUser", "firstName email"),
    Recipe.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: recipes.map(buildRecipeSummary),
    meta: buildPagination(page, limit, total),
  });
});

export const getAdminRecipeById = catchAsync(async (req, res) => {
  const { recipeId } = req.params;
  if (!mongoose.isValidObjectId(recipeId)) {
    throw new AppError("Invalid recipe id.", httpStatus.BAD_REQUEST);
  }

  const recipe = await Recipe.findById(recipeId).populate("assignedUser", "firstName email");
  if (!recipe) {
    throw new AppError("Recipe not found.", httpStatus.NOT_FOUND);
  }

  res.status(httpStatus.OK).json({
    success: true,
    data: buildRecipeDetails(recipe),
  });
});

export const updateAdminRecipe = catchAsync(async (req, res) => {
  const { recipeId } = req.params;
  if (!mongoose.isValidObjectId(recipeId)) {
    throw new AppError("Invalid recipe id.", httpStatus.BAD_REQUEST);
  }

  const recipe = await Recipe.findById(recipeId);
  if (!recipe) {
    throw new AppError("Recipe not found.", httpStatus.NOT_FOUND);
  }

  const previousRecipeImages = normalizeMediaList(recipe.recipeImages);
  const updates = await buildUpdatePayload(await getRecipeBodyFromRequest(req), recipe);
  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields were provided for update.", httpStatus.BAD_REQUEST);
  }

  Object.assign(recipe, updates, { updatedBy: req.user._id });
  await recipe.save();

  const removedCloudinaryAssets = resolveRemovedCloudinaryAssets(previousRecipeImages, recipe.recipeImages);
  await deleteCloudinaryAssets(removedCloudinaryAssets);

  const populated = await Recipe.findById(recipe._id).populate("assignedUser", "firstName email");

  res.status(httpStatus.OK).json({
    success: true,
    message: "Recipe updated successfully.",
    data: buildRecipeDetails(populated),
  });
});

export const deleteAdminRecipe = catchAsync(async (req, res) => {
  const { recipeId } = req.params;
  if (!mongoose.isValidObjectId(recipeId)) {
    throw new AppError("Invalid recipe id.", httpStatus.BAD_REQUEST);
  }

  const recipe = await Recipe.findById(recipeId);
  if (!recipe) {
    throw new AppError("Recipe not found.", httpStatus.NOT_FOUND);
  }

  const recipeCloudinaryAssets = normalizeMediaList(recipe.recipeImages)
    .map((asset) => getMediaAssetCloudinaryInfo(asset))
    .filter((asset) => asString(asset.publicId));

  await Recipe.deleteOne({ _id: recipe._id });
  await deleteCloudinaryAssets(recipeCloudinaryAssets);
  await User.updateMany(
    { "favoriteRecipeRefs.recipe": recipe._id },
    { $pull: { favoriteRecipeRefs: { recipe: recipe._id } } }
  );

  res.status(httpStatus.OK).json({
    success: true,
    message: "Recipe deleted successfully.",
  });
});

export const listPremiumUsersForRecipes = catchAsync(async (req, res) => {
  const search = asString(req.query.search);

  const query = {
    role: "user",
    isActive: true,
    selectedPlan: "premium_plan",
    subscriptionStatus: "active",
  };

  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    query.$or = [{ firstName: pattern }, { email: pattern }];
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

export const getExploreRecipes = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = {
    status: "published",
    isActive: true,
    userType: "normal_user",
  };

  if (req.query.recipeType) {
    filter.recipeType = normalizeRecipeType(req.query.recipeType);
  }

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.$or = [{ recipeName: pattern }, { howToPrepare: pattern }, { ingredients: { $elemMatch: pattern } }];
  }

  const [recipes, total] = await Promise.all([
    Recipe.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Recipe.countDocuments(filter),
  ]);
  const favoriteRecipeIds = getFavoriteRecipeIdSet(req.user);

  res.status(httpStatus.OK).json({
    success: true,
    data: recipes.map((recipe) =>
      buildRecipeSummary(recipe, {
        isFavorite: favoriteRecipeIds.has(String(recipe._id)),
      })
    ),
    meta: buildPagination(page, limit, total),
  });
});

export const getMyRecipes = catchAsync(async (req, res) => {
  if (!isPremiumActiveUser(req.user)) {
    throw new AppError("Active premium subscription required to access personalized recipes.", httpStatus.FORBIDDEN);
  }

  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = {
    status: "published",
    isActive: true,
    userType: "premium_user",
    assignedUser: req.user._id,
  };

  if (req.query.recipeType) {
    filter.recipeType = normalizeRecipeType(req.query.recipeType);
  }

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.$or = [{ recipeName: pattern }, { howToPrepare: pattern }, { ingredients: { $elemMatch: pattern } }];
  }

  const [recipes, total] = await Promise.all([
    Recipe.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Recipe.countDocuments(filter),
  ]);
  const favoriteRecipeIds = getFavoriteRecipeIdSet(req.user);

  res.status(httpStatus.OK).json({
    success: true,
    data: recipes.map((recipe) =>
      buildRecipeSummary(recipe, {
        isFavorite: favoriteRecipeIds.has(String(recipe._id)),
      })
    ),
    meta: buildPagination(page, limit, total),
  });
});

export const getRecipeByIdForUser = catchAsync(async (req, res) => {
  const { recipeId } = req.params;

  if (!mongoose.isValidObjectId(recipeId)) {
    throw new AppError("Invalid recipe id.", httpStatus.BAD_REQUEST);
  }

  const recipe = await Recipe.findById(recipeId).populate("assignedUser", "firstName email");
  if (!recipe || !recipe.isActive) {
    throw new AppError("Recipe not found.", httpStatus.NOT_FOUND);
  }

  const favoriteRecipeIds = getFavoriteRecipeIdSet(req.user);

  if (req.user.role === "admin") {
    return res.status(httpStatus.OK).json({
      success: true,
      data: buildRecipeDetails(recipe, {
        isFavorite: favoriteRecipeIds.has(String(recipe._id)),
      }),
    });
  }

  if (!isRecipeAccessibleToUser(recipe, req.user)) {
    throw new AppError("You are not allowed to access this recipe.", httpStatus.FORBIDDEN);
  }

  return res.status(httpStatus.OK).json({
    success: true,
    data: buildRecipeDetails(recipe, {
      isFavorite: favoriteRecipeIds.has(String(recipe._id)),
    }),
  });
});

export const getAllAccessibleRecipes = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;
  const filter = buildUserAccessibleFilter(req.user);

  if (req.query.recipeType) {
    filter.recipeType = normalizeRecipeType(req.query.recipeType);
  }

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.$and = [{ $or: [{ recipeName: pattern }, { howToPrepare: pattern }, { ingredients: { $elemMatch: pattern } }] }];
  }

  const [recipes, total] = await Promise.all([
    Recipe.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Recipe.countDocuments(filter),
  ]);
  const favoriteRecipeIds = getFavoriteRecipeIdSet(req.user);

  res.status(httpStatus.OK).json({
    success: true,
    data: recipes.map((recipe) =>
      buildRecipeSummary(recipe, {
        isFavorite: favoriteRecipeIds.has(String(recipe._id)),
      })
    ),
    meta: buildPagination(page, limit, total),
  });
});

export const toggleRecipeFavorite = catchAsync(async (req, res) => {
  const { recipeId } = req.params;

  if (!mongoose.isValidObjectId(recipeId)) {
    throw new AppError("Invalid recipe id.", httpStatus.BAD_REQUEST);
  }

  const recipe = await Recipe.findById(recipeId).populate("assignedUser", "firstName email");
  if (!recipe || !recipe.isActive) {
    throw new AppError("Recipe not found.", httpStatus.NOT_FOUND);
  }

  if (!isRecipeAccessibleToUser(recipe, req.user)) {
    throw new AppError("You are not allowed to access this recipe.", httpStatus.FORBIDDEN);
  }

  const desiredFavorite =
    parseBoolean(req.body?.isFavorite ?? req.query?.isFavorite, "isFavorite");
  if (!Array.isArray(req.user.favoriteRecipeRefs)) {
    req.user.favoriteRecipeRefs = [];
  }
  const currentFavoriteIds = getFavoriteRecipeIdSet(req.user);
  const isAlreadyFavorite = currentFavoriteIds.has(String(recipe._id));
  const shouldFavorite =
    desiredFavorite === undefined ? !isAlreadyFavorite : desiredFavorite;

  if (shouldFavorite && !isAlreadyFavorite) {
    req.user.favoriteRecipeRefs.push({
      recipe: recipe._id,
      savedAt: new Date(),
    });
  }

  if (!shouldFavorite && isAlreadyFavorite) {
    req.user.favoriteRecipeRefs = (req.user.favoriteRecipeRefs || []).filter(
      (item) => String(item?.recipe || item) !== String(recipe._id)
    );
  }

  await req.user.save({ validateBeforeSave: false });

  res.status(httpStatus.OK).json({
    success: true,
    message: shouldFavorite
      ? "Recipe added to favorites."
      : "Recipe removed from favorites.",
    data: {
      recipeId: recipe._id,
      isFavorite: shouldFavorite,
    },
  });
});
