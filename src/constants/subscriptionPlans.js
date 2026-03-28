export const SUBSCRIPTION_PLANS = Object.freeze([
  {
    key: "monthly",
    name: "Monthly Plan",
    price: 29.99,
    currency: "USD",
    durationMonths: 1,
    trialDays: 0,
    features: ["Full Workout Library Access", "Adaptive Training Plans", "Recipes", "Calorie Calculator"],
  },
  {
    key: "quarterly",
    name: "Quarterly Plan",
    price: 149.99,
    currency: "USD",
    durationMonths: 3,
    trialDays: 0,
    features: ["Full Workout Library Access", "Adaptive Training Plans", "Recipes", "Calorie Calculator"],
  },
  {
    key: "annual",
    name: "Annual Plan",
    price: 144,
    currency: "USD",
    durationMonths: 12,
    trialDays: 0,
    features: ["Full Workout Library Access", "Adaptive Training Plans", "Recipes", "Calorie Calculator"],
  },
  {
    key: "premium",
    name: "Premium Plan",
    price: 150,
    currency: "USD",
    durationMonths: 1,
    trialDays: 0,
    features: [
      "Full Workout Library Access",
      "Personalized Training Plan",
      "Recipes",
      "Calorie Calculator",
      "Weekly Check-In with the Coach",
    ],
  },
]);

export const PLAN_KEY_ALIASES = Object.freeze({
  free_trial: "annual",
  annual_plan: "annual",
  six_month_plan: "quarterly",
  quarterly_plan: "quarterly",
  monthly_plan: "monthly",
  premium_plan: "premium",
});

export const PLAN_KEYS = SUBSCRIPTION_PLANS.map((plan) => plan.key);
export const PLAN_ENUM_KEYS = [...new Set([...PLAN_KEYS, ...Object.keys(PLAN_KEY_ALIASES)])];

export const normalizePlanKey = (planKey) => {
  const normalized = String(planKey || "").trim().toLowerCase();
  if (!normalized) return "";
  if (PLAN_KEYS.includes(normalized)) return normalized;
  return PLAN_KEY_ALIASES[normalized] || "";
};

export const getPlanByKey = (planKey) => {
  const normalizedKey = normalizePlanKey(planKey);
  return SUBSCRIPTION_PLANS.find((plan) => plan.key === normalizedKey);
};

export const getPlanKeyVariants = (planKey) => {
  const normalizedKey = normalizePlanKey(planKey);
  if (!normalizedKey) return [];

  const aliases = Object.entries(PLAN_KEY_ALIASES)
    .filter(([, canonicalKey]) => canonicalKey === normalizedKey)
    .map(([alias]) => alias);

  return [normalizedKey, ...aliases];
};
