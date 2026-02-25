export const SUBSCRIPTION_PLANS = Object.freeze([
  {
    key: "free_trial",
    name: "Free Trial",
    price: 0,
    currency: "USD",
    trialDays: 7,
    durationMonths: 0,
    features: ["Full Home Workout Program", "Recipes"],
  },
  {
    key: "monthly_plan",
    name: "Monthly Plan",
    price: 29.99,
    currency: "USD",
    durationMonths: 1,
    features: ["Full Workout Library Access", "Adaptive Training Plans", "Recipes", "Calorie Calculator"],
  },
  {
    key: "six_month_plan",
    name: "Six Month Plan",
    price: 149.99,
    currency: "USD",
    durationMonths: 6,
    features: ["Full Workout Library Access", "Adaptive Training Plans", "Recipes", "Calorie Calculator"],
  },
  {
    key: "premium_plan",
    name: "Premium",
    price: 150,
    currency: "USD",
    durationMonths: 1,
    features: [
      "Full Workout Library Access",
      "Personalized Training Plan",
      "Recipes",
      "Calorie Calculator",
      "Weekly Check-In with the Coach",
    ],
  },
]);

export const PLAN_KEYS = SUBSCRIPTION_PLANS.map((plan) => plan.key);

export const getPlanByKey = (planKey) => SUBSCRIPTION_PLANS.find((plan) => plan.key === planKey);
