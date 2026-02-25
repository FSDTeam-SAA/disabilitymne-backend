import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { serializeUser } from "../utils/serializeUser.js";
import { getPlanByKey } from "../constants/subscriptionPlans.js";

const MAX_ONBOARDING_STEP = 8;

const applyOnboardingUpdates = (user, payload) => {
  const updates = payload || {};

  if (Object.hasOwn(updates, "firstName")) {
    user.firstName = updates.firstName;
  }

  if (Object.hasOwn(updates, "phone")) {
    user.phone = updates.phone;
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

export const getMe = catchAsync(async (req, res) => {
  res.status(httpStatus.OK).json({
    success: true,
    data: serializeUser(req.user),
  });
});

export const updateMe = catchAsync(async (req, res) => {
  applyOnboardingUpdates(req.user, req.body);
  await req.user.save();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Profile updated successfully.",
    data: serializeUser(req.user),
  });
});

export const updateOnboarding = catchAsync(async (req, res) => {
  applyOnboardingUpdates(req.user, req.body);
  await req.user.save();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Onboarding step saved successfully.",
    data: serializeUser(req.user),
  });
});

export const selectPlan = catchAsync(async (req, res) => {
  const { planKey } = req.body;

  if (!planKey) {
    throw new AppError("planKey is required.", httpStatus.BAD_REQUEST);
  }

  const plan = getPlanByKey(planKey);
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
