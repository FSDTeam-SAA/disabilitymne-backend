import { normalizePlanKey } from "../constants/subscriptionPlans.js";
import { deriveSubscriptionStatus } from "../services/subscriptionSync.service.js";

export const isSubscriptionCurrentlyActive = (user) => {
  if (!user) return false;

  const status = deriveSubscriptionStatus(user);
  if (status === "active" || status === "trial") {
    return true;
  }

  // Legacy path: status field says active and end date still valid
  if (user.subscriptionStatus !== "active") {
    return false;
  }

  if (!user.subscriptionEndsAt) {
    return true;
  }

  return new Date(user.subscriptionEndsAt).getTime() > Date.now();
};

export const isPremiumActiveUser = (user) =>
  Boolean(
    user &&
      normalizePlanKey(user.selectedPlan) === "premium" &&
      isSubscriptionCurrentlyActive(user)
  );
