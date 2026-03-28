import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import {
  PLAN_KEY_ALIASES,
  SUBSCRIPTION_PLANS,
  normalizePlanKey,
} from "../src/constants/subscriptionPlans.js";
import { SubscriptionPlan } from "../src/models/subscriptionPlan.model.js";
import { User } from "../src/models/user.model.js";
import { Payment } from "../src/models/payment.model.js";

const PLAN_DEFAULTS_BY_KEY = new Map(SUBSCRIPTION_PLANS.map((plan) => [plan.key, plan]));
const ALIAS_ENTRIES = Object.entries(PLAN_KEY_ALIASES);

const run = async () => {
  await connectDB();

  let renamedPlans = 0;
  let mergedPlans = 0;
  let userUpdates = 0;
  let paymentUpdates = 0;

  for (const [legacyKey, canonicalKey] of ALIAS_ENTRIES) {
    const legacyPlans = await SubscriptionPlan.find({ key: legacyKey });
    if (legacyPlans.length === 0) {
      continue;
    }

    for (const legacyPlan of legacyPlans) {
      const canonicalPlan = await SubscriptionPlan.findOne({
        _id: { $ne: legacyPlan._id },
        key: canonicalKey,
      });

      if (!canonicalPlan) {
        legacyPlan.key = canonicalKey;

        if (!legacyPlan.name) {
          legacyPlan.name = PLAN_DEFAULTS_BY_KEY.get(canonicalKey)?.name || canonicalKey;
        }

        await legacyPlan.save({ validateBeforeSave: false });
        renamedPlans += 1;
        continue;
      }

      const preferredSource = legacyPlan.updatedAt > canonicalPlan.updatedAt ? legacyPlan : canonicalPlan;
      canonicalPlan.name = preferredSource.name || canonicalPlan.name;
      canonicalPlan.price = preferredSource.price;
      canonicalPlan.currency = preferredSource.currency;
      canonicalPlan.durationLabel = preferredSource.durationLabel || canonicalPlan.durationLabel;
      canonicalPlan.durationMonths = preferredSource.durationMonths;
      canonicalPlan.trialDays = preferredSource.trialDays;
      canonicalPlan.features = Array.isArray(preferredSource.features) ? preferredSource.features : [];
      canonicalPlan.isPopular = normalizePlanKey(canonicalPlan.key) === "premium";
      canonicalPlan.sortOrder = preferredSource.sortOrder;
      canonicalPlan.isActive = canonicalPlan.isActive || legacyPlan.isActive;
      canonicalPlan.deletedAt = canonicalPlan.isActive ? null : canonicalPlan.deletedAt;

      await canonicalPlan.save({ validateBeforeSave: false });

      legacyPlan.isActive = false;
      legacyPlan.deletedAt = legacyPlan.deletedAt || new Date();
      await legacyPlan.save({ validateBeforeSave: false });
      mergedPlans += 1;
    }

    const userResult = await User.updateMany({ selectedPlan: legacyKey }, { $set: { selectedPlan: canonicalKey } });
    userUpdates += userResult.modifiedCount || 0;

    const paymentResult = await Payment.updateMany({ planKey: legacyKey }, { $set: { planKey: canonicalKey } });
    paymentUpdates += paymentResult.modifiedCount || 0;
  }

  console.log(
    `Plan key migration complete. Renamed plans: ${renamedPlans}, merged plans: ${mergedPlans}, updated users: ${userUpdates}, updated payments: ${paymentUpdates}`
  );

  await mongoose.connection.close();
};

run().catch(async (error) => {
  console.error("Plan key migration failed:", error);
  await mongoose.connection.close();
  process.exit(1);
});
