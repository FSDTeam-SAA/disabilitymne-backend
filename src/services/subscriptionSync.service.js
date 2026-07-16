import { User } from "../models/user.model.js";
import { SubscriptionHistory } from "../models/subscriptionHistory.model.js";
import { normalizePlanKey } from "../constants/subscriptionPlans.js";

/**
 * Derive the canonical subscription status from user fields.
 * Ensures expired subscriptions are not reported as active.
 */
export const deriveSubscriptionStatus = (user, now = new Date()) => {
  if (!user) return "none";

  const raw = String(user.subscriptionStatus || "none").toLowerCase();
  const endsAt = user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt) : null;

  if (raw === "cancelled") return "cancelled";
  if (raw === "pending_payment") return "pending_payment";
  if (raw === "none") return "none";

  if (raw === "trial") {
    const trialEnds = user.trialEndsAt ? new Date(user.trialEndsAt) : endsAt;
    if (trialEnds && trialEnds.getTime() <= now.getTime()) {
      return "expired";
    }
    return "trial";
  }

  if (raw === "active") {
    if (endsAt && endsAt.getTime() <= now.getTime()) {
      return "expired";
    }
    return "active";
  }

  if (raw === "expired") return "expired";

  if (endsAt && endsAt.getTime() <= now.getTime()) {
    return "expired";
  }

  return raw || "none";
};

export const recordSubscriptionHistory = async ({
  user,
  previousStatus,
  newStatus,
  previousPlanKey,
  planKey,
  reason = "sync",
  note = "",
  changedBy = null,
  metadata = {},
}) => {
  if (!user?._id) return null;
  if (previousStatus === newStatus && previousPlanKey === planKey) return null;

  return SubscriptionHistory.create({
    user: user._id,
    planKey: planKey || normalizePlanKey(user.selectedPlan) || "",
    previousPlanKey: previousPlanKey || "",
    previousStatus: previousStatus || "none",
    newStatus,
    subscriptionStartedAt: user.subscriptionStartedAt || null,
    subscriptionEndsAt: user.subscriptionEndsAt || null,
    reason,
    note,
    changedBy,
    metadata,
  });
};

/**
 * Sync a single user's subscriptionStatus field if it drifted (e.g. expired).
 */
export const syncUserSubscriptionStatus = async (user, { changedBy = null, reason = "sync" } = {}) => {
  if (!user) return user;

  const previousStatus = String(user.subscriptionStatus || "none").toLowerCase();
  const derived = deriveSubscriptionStatus(user);

  if (previousStatus === derived) {
    return user;
  }

  const previousPlanKey = normalizePlanKey(user.selectedPlan) || "";
  user.subscriptionStatus = derived;
  await user.save({ validateBeforeSave: false });

  await recordSubscriptionHistory({
    user,
    previousStatus,
    newStatus: derived,
    previousPlanKey,
    planKey: previousPlanKey,
    reason,
    changedBy,
  });

  return user;
};

/**
 * Bulk-expire subscriptions whose end date has passed but status is still active/trial.
 */
export const syncExpiredSubscriptions = async ({ limit = 500 } = {}) => {
  const now = new Date();

  const candidates = await User.find({
    role: "user",
    subscriptionStatus: { $in: ["active", "trial"] },
    subscriptionEndsAt: { $ne: null, $lte: now },
  })
    .limit(limit)
    .select(
      "selectedPlan subscriptionStatus subscriptionStartedAt subscriptionEndsAt trialEndsAt"
    );

  let updated = 0;
  for (const user of candidates) {
    await syncUserSubscriptionStatus(user, { reason: "expiry" });
    updated += 1;
  }

  return { scanned: candidates.length, updated };
};

export const toSubscriptionSummary = (user) => {
  const status = deriveSubscriptionStatus(user);
  const planKey = normalizePlanKey(user?.selectedPlan) || null;

  return {
    planKey,
    selectedPlan: planKey,
    subscriptionStatus: status,
    subscriptionStartedAt: user?.subscriptionStartedAt || null,
    subscriptionEndsAt: user?.subscriptionEndsAt || null,
    trialEndsAt: user?.trialEndsAt || null,
    isSponsored: Boolean(user?.isSponsored),
    isActive: status === "active" || status === "trial",
    isPremium: planKey === "premium" && (status === "active" || status === "trial"),
  };
};
