import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { serializeUser } from "../utils/serializeUser.js";
import { getPlanByKey } from "../services/subscriptionPlan.service.js";
import { mergeUploadedMediaIntoBody } from "../utils/uploadedMedia.js";

const MAX_ONBOARDING_STEP = 8;
const ALLOWED_LANGUAGE_CODES = new Set(["en", "sr"]);
const PROFILE_IMAGE_FIELDS = ["profileImage", "avatar", "image"];

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
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
    user.onboardingCompleted = Boolean(updates.onboardingCompleted);
  }

  if (user.onboardingStep >= MAX_ONBOARDING_STEP) {
    user.onboardingCompleted = true;
  }
};

const getProfileBodyFromRequest = (req) =>
  mergeUploadedMediaIntoBody(req.body, req.files, [{ target: "profileImage", fieldNames: PROFILE_IMAGE_FIELDS }]);

export const getMe = catchAsync(async (req, res) => {
  res.status(httpStatus.OK).json({
    success: true,
    data: serializeUser(req.user),
  });
});

export const updateMe = catchAsync(async (req, res) => {
  applyOnboardingUpdates(req.user, getProfileBodyFromRequest(req));
  await req.user.save();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Profile updated successfully.",
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
