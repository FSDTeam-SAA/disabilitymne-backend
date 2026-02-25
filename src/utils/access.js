export const isPremiumActiveUser = (user) =>
  Boolean(user && user.selectedPlan === "premium_plan" && user.subscriptionStatus === "active");
