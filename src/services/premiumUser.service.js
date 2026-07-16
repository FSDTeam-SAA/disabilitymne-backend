import mongoose from "mongoose";
import { Program } from "../models/program.model.js";
import { Exercise } from "../models/exercise.model.js";
import { Recipe } from "../models/recipe.model.js";
import { NutritionPlan } from "../models/nutritionPlan.model.js";
import { UserExerciseSetting } from "../models/userExerciseSetting.model.js";
import { UserProgram } from "../models/userProgram.model.js";
import { ChatThread } from "../models/chatThread.model.js";
import { ChatMessage } from "../models/chatMessage.model.js";
import { recordSubscriptionHistory } from "./subscriptionSync.service.js";
import { normalizePlanKey } from "../constants/subscriptionPlans.js";

/**
 * Soft-remove premium access while keeping the normal user account.
 * Cascades soft-delete of assigned premium content (non-template).
 */
export const removePremiumAccess = async (user, { changedBy = null, note = "" } = {}) => {
  const userId = user._id;
  const previousStatus = String(user.subscriptionStatus || "none").toLowerCase();
  const previousPlanKey = normalizePlanKey(user.selectedPlan) || "";

  await Promise.all([
    Program.updateMany(
      {
        userType: "premium_user",
        assignedUser: userId,
        isTemplate: { $ne: true },
      },
      { $set: { isActive: false, status: "archived" } }
    ),
    NutritionPlan.updateMany(
      {
        assignedUser: userId,
        isTemplate: { $ne: true },
      },
      { $set: { isActive: false, status: "archived" } }
    ),
    Exercise.updateMany(
      {
        userType: "premium_user",
        assignedUser: userId,
      },
      { $set: { isActive: false, status: "archived" } }
    ),
    Recipe.updateMany(
      {
        userType: "premium_user",
        assignedUser: userId,
      },
      { $set: { isActive: false, status: "archived" } }
    ),
    UserExerciseSetting.deleteMany({ user: userId }),
    UserProgram.deleteMany({ user: userId }),
  ]);

  const threads = await ChatThread.find({ premiumUser: userId }).select("_id");
  const threadIds = threads.map((t) => t._id);
  if (threadIds.length > 0) {
    await ChatMessage.deleteMany({ thread: { $in: threadIds } });
    await ChatThread.deleteMany({ _id: { $in: threadIds } });
  }

  user.selectedPlan = null;
  user.subscriptionStatus = "cancelled";
  user.subscriptionEndsAt = new Date();
  user.isSponsored = false;
  if (user.sponsorship) {
    user.sponsorship = {
      ...(user.sponsorship.toObject?.() || user.sponsorship || {}),
      note: note || user.sponsorship?.note || "Premium access removed by admin",
      revokedAt: new Date(),
      revokedBy: changedBy || null,
    };
  }

  await user.save({ validateBeforeSave: false });

  await recordSubscriptionHistory({
    user,
    previousStatus,
    newStatus: "cancelled",
    previousPlanKey,
    planKey: "",
    reason: "admin_revoke",
    note: note || "Premium access removed; user account retained.",
    changedBy,
  });

  return user;
};

/**
 * Hard-delete all premium-related records for a user (used before full account delete).
 */
export const deletePremiumRelatedRecords = async (userId) => {
  const userObjectId = new mongoose.Types.ObjectId(userId);

  await Promise.all([
    Program.deleteMany({
      userType: "premium_user",
      assignedUser: userObjectId,
      isTemplate: { $ne: true },
    }),
    NutritionPlan.deleteMany({
      assignedUser: userObjectId,
      isTemplate: { $ne: true },
    }),
    Exercise.deleteMany({
      userType: "premium_user",
      assignedUser: userObjectId,
    }),
    Recipe.deleteMany({
      userType: "premium_user",
      assignedUser: userObjectId,
    }),
  ]);
};
