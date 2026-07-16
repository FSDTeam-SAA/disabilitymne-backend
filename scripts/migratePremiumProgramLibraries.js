/**
 * One-off schema alignment for premium program libraries, exercise customization,
 * activity level, and subscription history indexes.
 *
 * Usage: node scripts/migratePremiumProgramLibraries.js
 *
 * Safe to re-run. Does not delete existing data.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function run() {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is required");
  }

  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;

  console.log("Connected. Applying premium library / subscription migrations...");

  // Ensure Program.isTemplate defaults
  const programResult = await db.collection("programs").updateMany(
    { isTemplate: { $exists: false } },
    { $set: { isTemplate: false, sourceTemplate: null } }
  );
  console.log(`Programs backfilled isTemplate: ${programResult.modifiedCount}`);

  // Ensure NutritionPlan.isTemplate defaults and optional assignedUser for templates
  const nutritionResult = await db.collection("nutritionplans").updateMany(
    { isTemplate: { $exists: false } },
    { $set: { isTemplate: false, sourceTemplate: null } }
  );
  console.log(`Nutrition plans backfilled isTemplate: ${nutritionResult.modifiedCount}`);

  // User activityLevel default
  const userResult = await db.collection("users").updateMany(
    { activityLevel: { $exists: false } },
    { $set: { activityLevel: "moderately_active" } }
  );
  console.log(`Users backfilled activityLevel: ${userResult.modifiedCount}`);

  // Create subscriptionhistories collection indexes if missing
  const history = db.collection("subscriptionhistories");
  await history.createIndex({ user: 1, createdAt: -1 });
  await history.createIndex({ newStatus: 1, createdAt: -1 });
  console.log("SubscriptionHistory indexes ensured");

  await db.collection("programs").createIndex({ isTemplate: 1, userType: 1, status: 1, isActive: 1, createdAt: -1 });
  await db.collection("nutritionplans").createIndex({ isTemplate: 1, status: 1, isActive: 1, createdAt: -1 });
  console.log("Template indexes ensured");

  // Expire stale active subscriptions
  const now = new Date();
  const expired = await db.collection("users").updateMany(
    {
      role: "user",
      subscriptionStatus: { $in: ["active", "trial"] },
      subscriptionEndsAt: { $ne: null, $lte: now },
    },
    { $set: { subscriptionStatus: "expired" } }
  );
  console.log(`Expired stale subscriptions: ${expired.modifiedCount}`);

  await mongoose.disconnect();
  console.log("Done.");
}

run().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
