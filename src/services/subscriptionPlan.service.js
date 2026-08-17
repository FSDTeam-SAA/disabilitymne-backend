import {
  PLAN_KEYS,
  SUBSCRIPTION_PLANS,
  getPlanKeyVariants,
  normalizePlanKey,
} from "../constants/subscriptionPlans.js";
import { SubscriptionPlan } from "../models/subscriptionPlan.model.js";

const normalizePlan = (planDoc) => {
  const normalizedKey = normalizePlanKey(planDoc.key) || String(planDoc.key || "").toLowerCase();

  return {
    key: normalizedKey,
    name: planDoc.name,
    price: planDoc.price,
    currency: planDoc.currency,
    durationMonths: planDoc.durationMonths,
    durationLabel: planDoc.durationLabel,
    trialDays: planDoc.trialDays,
    features: planDoc.features || [],
    isPopular: Boolean(planDoc.isPopular || normalizedKey === "premium"),
  };
};

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
  isPopular: plan.key === "premium",
  sortOrder: index + 1,
  isActive: true,
});

export const ensureDefaultPlansIfEmpty = async () => {
  const activePlans = await SubscriptionPlan.find({ isActive: true }).select("key").lean();
  const activeCanonicalKeys = new Set(activePlans.map((plan) => normalizePlanKey(plan.key)).filter(Boolean));
  const missingPlans = SUBSCRIPTION_PLANS.filter((plan) => !activeCanonicalKeys.has(plan.key));

  if (missingPlans.length === 0) {
    return;
  }

  for (let index = 0; index < missingPlans.length; index += 1) {
    const plan = missingPlans[index];
    const sortOrderIndex = PLAN_KEYS.indexOf(plan.key);

    await SubscriptionPlan.updateOne(
      { key: plan.key },
      {
        $setOnInsert: toSeedPayload(plan, sortOrderIndex),
        $set: {
          isActive: true,
          deletedAt: null,
        },
      },
      { upsert: true }
    );
  }
};

/**
 * Keep DB plan prices/currency aligned with the canonical USD catalog so the
 * app never drifts into EUR (or stale amounts) after admin/seed changes.
 */
export const syncCanonicalPlanPricing = async () => {
  await ensureDefaultPlansIfEmpty();

  for (let index = 0; index < SUBSCRIPTION_PLANS.length; index += 1) {
    const plan = SUBSCRIPTION_PLANS[index];
    const variants = getPlanKeyVariants(plan.key);

    await SubscriptionPlan.updateMany(
      { key: { $in: variants }, isActive: true },
      {
        $set: {
          name: plan.name,
          price: plan.price,
          currency: "USD",
          durationMonths: plan.durationMonths || 0,
          durationLabel: getDefaultDurationLabel(plan),
          trialDays: plan.trialDays || 0,
          features: plan.features || [],
          isPopular: plan.key === "premium",
          sortOrder: index + 1,
        },
      }
    );
  }
};

const withForcedUsd = (plan) => {
  if (!plan) return plan;
  return {
    ...plan,
    currency: "USD",
    price: Number(plan.price) || 0,
  };
};

export const getActivePlans = async () => {
  await syncCanonicalPlanPricing();
  const plans = await SubscriptionPlan.find({ isActive: true }).sort({ sortOrder: 1, createdAt: 1 });
  const normalizedByKey = new Map();

  for (const planDoc of plans) {
    const normalizedKey = normalizePlanKey(planDoc.key);
    if (!normalizedKey) continue;

    const existing = normalizedByKey.get(normalizedKey);
    const isCanonicalDoc = String(planDoc.key || "").toLowerCase() === normalizedKey;

    if (!existing || (!existing.isCanonicalDoc && isCanonicalDoc)) {
      normalizedByKey.set(normalizedKey, {
        isCanonicalDoc,
        plan: withForcedUsd(normalizePlan(planDoc)),
      });
    }
  }

  return PLAN_KEYS.map((key) => normalizedByKey.get(key)?.plan).filter(Boolean);
};

export const getPlanByKey = async (planKey) => {
  await syncCanonicalPlanPricing();
  const normalizedKey = normalizePlanKey(planKey);
  if (!normalizedKey) return null;

  const variants = getPlanKeyVariants(normalizedKey);
  const planDocs = await SubscriptionPlan.find({
    key: { $in: variants },
    isActive: true,
  }).sort({ sortOrder: 1, createdAt: 1 });

  if (!planDocs.length) return null;

  const canonicalDoc =
    planDocs.find((planDoc) => String(planDoc.key || "").toLowerCase() === normalizedKey) || planDocs[0];

  return withForcedUsd(normalizePlan(canonicalDoc));
};
