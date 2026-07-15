import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { User } from "../models/user.model.js";
import {
  AppSettings,
  DEFAULT_MAX_PREMIUM_USERS,
} from "../models/appSettings.model.js";
import { getPlanKeyVariants, normalizePlanKey } from "../constants/subscriptionPlans.js";
import { isPremiumActiveUser } from "../utils/access.js";

export const PREMIUM_FULL_MESSAGE =
  "Premium memberships are currently full. Please check back later for availability.";

const PREMIUM_PLAN_KEYS = getPlanKeyVariants("premium");

export const getOrCreateAppSettings = async () => {
  let settings = await AppSettings.findOne({ key: "global" });
  if (!settings) {
    settings = await AppSettings.create({
      key: "global",
      maxPremiumUsers: DEFAULT_MAX_PREMIUM_USERS,
    });
  }
  return settings;
};

export const buildActivePremiumFilter = () => {
  const now = new Date();
  return {
    role: "user",
    isActive: true,
    accountStatus: "active",
    selectedPlan: { $in: PREMIUM_PLAN_KEYS },
    subscriptionStatus: "active",
    $or: [{ subscriptionEndsAt: null }, { subscriptionEndsAt: { $gt: now } }],
  };
};

export const countActivePremiumUsers = async (excludeUserId = null) => {
  const filter = buildActivePremiumFilter();
  if (excludeUserId) {
    filter._id = { $ne: excludeUserId };
  }
  return User.countDocuments(filter);
};

export const getPremiumCapacitySnapshot = async ({ excludeUserId = null } = {}) => {
  const [settings, currentPremiumUsers] = await Promise.all([
    getOrCreateAppSettings(),
    countActivePremiumUsers(excludeUserId),
  ]);

  const maxPremiumUsers = Number(settings.maxPremiumUsers ?? DEFAULT_MAX_PREMIUM_USERS);
  const spotsRemaining = Math.max(0, maxPremiumUsers - currentPremiumUsers);
  const available = spotsRemaining > 0;

  return {
    maxPremiumUsers,
    currentPremiumUsers,
    spotsRemaining,
    available,
    message: available ? null : PREMIUM_FULL_MESSAGE,
  };
};

export const isPremiumPlanKey = (planKey) => normalizePlanKey(planKey) === "premium";

/**
 * Blocks new Premium activations when at capacity.
 * Users who are already active Premium (renewals/restores) are allowed through.
 */
export const assertPremiumCapacityAvailable = async ({
  user = null,
  planKey,
  excludeUserId = null,
} = {}) => {
  if (!isPremiumPlanKey(planKey)) {
    return getPremiumCapacitySnapshot({ excludeUserId });
  }

  if (user && isPremiumActiveUser(user)) {
    return getPremiumCapacitySnapshot({
      excludeUserId: excludeUserId || user._id,
    });
  }

  const snapshot = await getPremiumCapacitySnapshot({
    excludeUserId: excludeUserId || user?._id || null,
  });

  if (!snapshot.available) {
    throw new AppError(PREMIUM_FULL_MESSAGE, httpStatus.CONFLICT);
  }

  return snapshot;
};

export const updateMaxPremiumUsers = async (maxPremiumUsers) => {
  const parsed = Number(maxPremiumUsers);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new AppError("maxPremiumUsers must be a non-negative integer.", httpStatus.BAD_REQUEST);
  }

  const settings = await getOrCreateAppSettings();
  settings.maxPremiumUsers = parsed;
  await settings.save();

  return getPremiumCapacitySnapshot();
};
