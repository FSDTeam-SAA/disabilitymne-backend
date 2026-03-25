import httpStatus from "http-status";
import fs from "node:fs/promises";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { serializeUser } from "../utils/serializeUser.js";
import { getPlanByKey } from "../services/subscriptionPlan.service.js";
import { uploadImageFileToCloudinary } from "../services/cloudinary.service.js";
import { mergeUploadedMediaIntoBody } from "../utils/uploadedMedia.js";

const MAX_ONBOARDING_STEP = 8;
const ALLOWED_LANGUAGE_CODES = new Set(["en", "sr"]);
const PROFILE_IMAGE_FIELDS = ["profileImage", "avatar", "image"];

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

const parseBooleanInput = (value, fieldName) => {
  if (typeof value === "boolean") return value;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  throw new AppError(`${fieldName} must be a boolean.`, httpStatus.BAD_REQUEST);
};

const normalizeFitnessGoalsInput = (value) => {
  const parsed = parseMaybeJson(value);

  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (typeof parsed === "string") {
    const fromCsv = parsed
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (fromCsv.length > 0) {
      return fromCsv;
    }
  }

  return parsed;
};

const normalizeProfileImage = (value) => {
  if (value === null || value === "") {
    return null;
  }

  if (typeof value === "string") {
    const url = asString(value);
    return url
      ? {
        url,
        publicId: "",
        mimetype: "",
        size: 0,
      }
      : null;
  }

  if (typeof value !== "object") {
    throw new AppError("profileImage must be a string URL or media object.", httpStatus.BAD_REQUEST);
  }

  const url = asString(value.url || value.path || value.secure_url);
  if (!url) {
    throw new AppError("profileImage.url is required.", httpStatus.BAD_REQUEST);
  }

  const size = Number(value.size);

  return {
    url,
    publicId: asString(value.publicId || value.public_id || value.filename),
    mimetype: asString(value.mimetype || value.resource_type || value.format),
    size: Number.isFinite(size) && size > 0 ? size : 0,
  };
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

const getFirstUploadedProfileFile = (files) => {
  const groupedFiles = normalizeUploadedFiles(files);

  for (const fieldName of PROFILE_IMAGE_FIELDS) {
    const fieldFiles = groupedFiles[fieldName];
    if (Array.isArray(fieldFiles) && fieldFiles.length > 0) {
      return fieldFiles[0];
    }
  }

  return null;
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

const applyCloudinaryProfileImage = async (req, payload) => {
  const uploadedFile = getFirstUploadedProfileFile(req.files);
  if (!uploadedFile) {
    return payload;
  }

  try {
    const cloudinaryAsset = await uploadImageFileToCloudinary(uploadedFile, {
      folder: "users/profile-images",
    });

    return {
      ...(payload || {}),
      profileImage: cloudinaryAsset,
    };
  } catch (error) {
    throw new AppError(asString(error?.message) || "Failed to upload profile image to Cloudinary.", httpStatus.INTERNAL_SERVER_ERROR);
  } finally {
    await cleanupTemporaryUpload(uploadedFile);
  }
};

const applyOnboardingUpdates = (user, payload) => {
  const updates = payload || {};

  if (Object.hasOwn(updates, "firstName")) {
    user.firstName = updates.firstName;
  }

  if (Object.hasOwn(updates, "lastName")) {
    user.lastName = updates.lastName;
  }

  if (Object.hasOwn(updates, "phone")) {
    user.phone = updates.phone;
  }

  if (Object.hasOwn(updates, "bio")) {
    user.bio = updates.bio;
  }

  if (Object.hasOwn(updates, "preferredLanguage")) {
    const preferredLanguage = asString(updates.preferredLanguage).toLowerCase();
    if (!ALLOWED_LANGUAGE_CODES.has(preferredLanguage)) {
      throw new AppError("preferredLanguage must be one of: en, sr.", httpStatus.BAD_REQUEST);
    }
    user.preferredLanguage = preferredLanguage;
  }

  if (Object.hasOwn(updates, "profileImage")) {
    user.profileImage = normalizeProfileImage(updates.profileImage);
  }

  if (Object.hasOwn(updates, "gender")) {
    user.gender = updates.gender;
  }

  if (Object.hasOwn(updates, "age")) {
    user.age = updates.age;
  }

  if (Object.hasOwn(updates, "weightCurrent")) {
    user.weightCurrent = updates.weightCurrent;
  }

  if (Object.hasOwn(updates, "goalWeight")) {
    user.goalWeight = updates.goalWeight;
  }

  if (Object.hasOwn(updates, "height")) {
    user.height = updates.height;
  }

  if (Object.hasOwn(updates, "fitnessGoals")) {
    if (!Array.isArray(updates.fitnessGoals)) {
      throw new AppError("fitnessGoals must be an array.", httpStatus.BAD_REQUEST);
    }
    user.fitnessGoals = updates.fitnessGoals;
  }

  if (Object.hasOwn(updates, "mobilityType")) {
    user.mobilityType = updates.mobilityType;
  }

  if (Object.hasOwn(updates, "mobilityTypeOther")) {
    user.mobilityTypeOther = updates.mobilityTypeOther;
  }

  if (Object.hasOwn(updates, "fitnessExperience")) {
    user.fitnessExperience = updates.fitnessExperience;
  }

  if (Object.hasOwn(updates, "onboardingStep")) {
    const requestedStep = Number(updates.onboardingStep);
    if (!Number.isFinite(requestedStep) || requestedStep < 0 || requestedStep > MAX_ONBOARDING_STEP) {
      throw new AppError(`onboardingStep must be between 0 and ${MAX_ONBOARDING_STEP}.`, httpStatus.BAD_REQUEST);
    }

    user.onboardingStep = Math.max(user.onboardingStep, requestedStep);
  }

  if (Object.hasOwn(updates, "onboardingCompleted")) {
    user.onboardingCompleted = parseBooleanInput(updates.onboardingCompleted, "onboardingCompleted");
  }

  if (user.onboardingStep >= MAX_ONBOARDING_STEP) {
    user.onboardingCompleted = true;
  }
};

const getProfileBodyFromRequest = async (req) => {
  let payload = mergeUploadedMediaIntoBody(req.body, req.files, [{ target: "profileImage", fieldNames: PROFILE_IMAGE_FIELDS }]);
  payload = await applyCloudinaryProfileImage(req, payload);

  if (Array.isArray(payload.profileImage)) {
    payload.profileImage = payload.profileImage[0] || null;
  }

  if (Object.hasOwn(payload, "weightCurrent")) {
    payload.weightCurrent = parseMaybeJson(payload.weightCurrent);
  }

  if (Object.hasOwn(payload, "goalWeight")) {
    payload.goalWeight = parseMaybeJson(payload.goalWeight);
  }

  if (Object.hasOwn(payload, "height")) {
    payload.height = parseMaybeJson(payload.height);
  }

  if (Object.hasOwn(payload, "fitnessGoals")) {
    payload.fitnessGoals = normalizeFitnessGoalsInput(payload.fitnessGoals);
  }

  if (Object.hasOwn(payload, "onboardingCompleted")) {
    payload.onboardingCompleted = parseBooleanInput(payload.onboardingCompleted, "onboardingCompleted");
  }

  return payload;
};

const getProfileImageFromRequest = async (req) => {
  const payload = await getProfileBodyFromRequest(req);

  if (!Object.hasOwn(payload, "profileImage")) {
    throw new AppError("profileImage is required.", httpStatus.BAD_REQUEST);
  }

  if (Array.isArray(payload.profileImage)) {
    return payload.profileImage[0] || null;
  }

  return payload.profileImage;
};

export const getMe = catchAsync(async (req, res) => {
  res.status(httpStatus.OK).json({
    success: true,
    data: serializeUser(req.user),
  });
});

export const updateMe = catchAsync(async (req, res) => {
  applyOnboardingUpdates(req.user, await getProfileBodyFromRequest(req));
  await req.user.save();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Profile updated successfully.",
    data: serializeUser(req.user),
  });
});

export const updateMyProfileImage = catchAsync(async (req, res) => {
  req.user.profileImage = normalizeProfileImage(await getProfileImageFromRequest(req));
  await req.user.save();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Profile image updated successfully.",
    data: serializeUser(req.user),
  });
});

export const selectPlan = catchAsync(async (req, res) => {
  const { planKey } = req.body;

  if (!planKey) {
    throw new AppError("planKey is required.", httpStatus.BAD_REQUEST);
  }

  const plan = await getPlanByKey(planKey);
  if (!plan) {
    throw new AppError("Invalid planKey provided.", httpStatus.BAD_REQUEST);
  }

  req.user.selectedPlan = plan.key;

  if (plan.price === 0) {
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + (plan.trialDays || 7) * 24 * 60 * 60 * 1000);

    req.user.subscriptionStatus = "trial";
    req.user.trialActivatedAt = now;
    req.user.trialEndsAt = trialEndsAt;
    req.user.subscriptionStartedAt = now;
    req.user.subscriptionEndsAt = trialEndsAt;
  } else {
    req.user.subscriptionStatus = "pending_payment";
    req.user.trialActivatedAt = null;
    req.user.trialEndsAt = null;
    req.user.subscriptionStartedAt = null;
    req.user.subscriptionEndsAt = null;
  }

  await req.user.save({ validateBeforeSave: false });

  res.status(httpStatus.OK).json({
    success: true,
    message: "Plan selected successfully.",
    data: {
      plan,
      user: serializeUser(req.user),
    },
  });
});

