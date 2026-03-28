import { normalizePlanKey } from "../constants/subscriptionPlans.js";

export const isPremiumActiveUser = (user) =>
  Boolean(user && normalizePlanKey(user.selectedPlan) === "premium" && user.subscriptionStatus === "active");
