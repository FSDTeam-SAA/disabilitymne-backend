import { SUBSCRIPTION_PLANS } from "../constants/subscriptionPlans.js";
import { SubscriptionPlan } from "../models/subscriptionPlan.model.js";

const normalizePlan = (planDoc) => ({
  key: planDoc.key,
  name: planDoc.name,
  price: planDoc.price,
  currency: planDoc.currency,
  durationMonths: planDoc.durationMonths,
  durationLabel: planDoc.durationLabel,
  trialDays: planDoc.trialDays,
  features: planDoc.features || [],
  isPopular: Boolean(planDoc.isPopular),
});

const getDefaultDurationLabel = (plan) => {
  if (plan.trialDays) {
    return `${plan.trialDays} days`;
  }

  if (plan.durationMonths === 1) {
    return "Monthly";
  }

  if (plan.durationMonths > 1) {
    return `${plan.durationMonths} months`;
  }

  return "One-time";
};

const toSeedPayload = (plan, index) => ({
  key: plan.key,
  name: plan.name,
  price: plan.price,
  currency: plan.currency || "USD",
  durationMonths: plan.durationMonths || 0,
  durationLabel: getDefaultDurationLabel(plan),
  trialDays: plan.trialDays || 0,
  features: plan.features || [],
  isPopular: plan.key === "premium_plan",
  sortOrder: index + 1,
  isActive: true,
});

export const ensureDefaultPlansIfEmpty = async () => {
  const count = await SubscriptionPlan.countDocuments({ isActive: true });
  if (count > 0) {
    return;
  }

  const plans = SUBSCRIPTION_PLANS.map((plan, index) => ({
    ...toSeedPayload(plan, index),
  }));

  await SubscriptionPlan.insertMany(plans, { ordered: true });
};

export const getActivePlans = async () => {
  await ensureDefaultPlansIfEmpty();
  const plans = await SubscriptionPlan.find({ isActive: true }).sort({ sortOrder: 1, createdAt: 1 });
  return plans.map(normalizePlan);
};

export const getPlanByKey = async (planKey) => {
  await ensureDefaultPlansIfEmpty();
  const planDoc = await SubscriptionPlan.findOne({ key: String(planKey || "").toLowerCase(), isActive: true });
  return planDoc ? normalizePlan(planDoc) : null;
};
