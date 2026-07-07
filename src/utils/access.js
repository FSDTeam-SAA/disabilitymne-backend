import { normalizePlanKey } from "../constants/subscriptionPlans.js";

export const isSubscriptionCurrentlyActive = (user) => {
  if (!user || user.subscriptionStatus !== "active") {
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
