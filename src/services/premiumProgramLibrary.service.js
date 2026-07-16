import mongoose from "mongoose";
import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { Program } from "../models/program.model.js";
import { NutritionPlan } from "../models/nutritionPlan.model.js";
import { User } from "../models/user.model.js";
import { isPremiumActiveUser } from "../utils/access.js";

const clonePlain = (doc) => {
  if (!doc) return null;
  const obj = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  delete obj._id;
  delete obj.id;
  delete obj.createdAt;
  delete obj.updatedAt;
  delete obj.__v;
  return obj;
};

export const ensureAssignablePremiumUser = async (userId) => {
  if (!mongoose.isValidObjectId(userId)) {
    throw new AppError("Invalid user id.", httpStatus.BAD_REQUEST);
  }

  const user = await User.findById(userId);
  if (!user || user.role !== "user" || !user.isActive) {
    throw new AppError("Assigned user was not found.", httpStatus.NOT_FOUND);
  }

  if (!isPremiumActiveUser(user)) {
    throw new AppError(
      "Assigned user must have an active premium subscription.",
      httpStatus.BAD_REQUEST
    );
  }

  return user;
};

/**
 * Clone a premium workout program template (or any program) onto a premium user.
 * Prevents duplicate active assignments from the same template.
 */
export const assignWorkoutProgramToUser = async ({
  programId,
  userId,
  adminId,
  allowDuplicate = false,
}) => {
  const template = await Program.findById(programId);
  if (!template || !template.isActive) {
    throw new AppError("Workout program not found.", httpStatus.NOT_FOUND);
  }

  if (template.userType !== "premium_user" && !template.isTemplate) {
    throw new AppError(
      "Only premium workout programs/templates can be assigned to premium users.",
      httpStatus.BAD_REQUEST
    );
  }

  const user = await ensureAssignablePremiumUser(userId);

  if (!allowDuplicate && template.isTemplate) {
    const existing = await Program.findOne({
      sourceTemplate: template._id,
      assignedUser: user._id,
      isActive: true,
      isTemplate: { $ne: true },
    }).select("_id");

    if (existing) {
      throw new AppError(
        "This program is already assigned to the user. Pass allowDuplicate=true to assign again.",
        httpStatus.CONFLICT
      );
    }
  }

  const payload = clonePlain(template);
  payload.userType = "premium_user";
  payload.isTemplate = false;
  payload.assignedUser = user._id;
  payload.sourceTemplate = template.isTemplate ? template._id : template.sourceTemplate || null;
  payload.createdBy = adminId || template.createdBy;
  payload.updatedBy = adminId || null;
  payload.status = payload.status === "archived" ? "published" : payload.status;
  payload.isActive = true;

  const assigned = await Program.create(payload);
  return assigned;
};

/**
 * Duplicate a program as a new template (or as a copy for editing).
 */
export const duplicateWorkoutProgram = async ({ programId, adminId, asTemplate = true }) => {
  const source = await Program.findById(programId);
  if (!source) {
    throw new AppError("Workout program not found.", httpStatus.NOT_FOUND);
  }

  const payload = clonePlain(source);
  payload.programName = `${source.programName} (Copy)`;
  payload.isTemplate = Boolean(asTemplate);
  payload.assignedUser = asTemplate ? null : source.assignedUser;
  payload.userType = "premium_user";
  payload.sourceTemplate = source.isTemplate ? source._id : source.sourceTemplate || null;
  payload.createdBy = adminId || source.createdBy;
  payload.updatedBy = adminId || null;
  payload.status = "draft";
  payload.isActive = true;

  return Program.create(payload);
};

export const assignMealProgramToUser = async ({
  planId,
  userId,
  adminId,
  allowDuplicate = false,
}) => {
  const template = await NutritionPlan.findById(planId);
  if (!template || !template.isActive) {
    throw new AppError("Meal program not found.", httpStatus.NOT_FOUND);
  }

  const user = await ensureAssignablePremiumUser(userId);

  if (!allowDuplicate && template.isTemplate) {
    const existing = await NutritionPlan.findOne({
      sourceTemplate: template._id,
      assignedUser: user._id,
      isActive: true,
      isTemplate: { $ne: true },
    }).select("_id");

    if (existing) {
      throw new AppError(
        "This meal program is already assigned to the user. Pass allowDuplicate=true to assign again.",
        httpStatus.CONFLICT
      );
    }
  }

  const payload = clonePlain(template);
  payload.isTemplate = false;
  payload.assignedUser = user._id;
  payload.sourceTemplate = template.isTemplate ? template._id : template.sourceTemplate || null;
  payload.createdBy = adminId || template.createdBy;
  payload.updatedBy = adminId || null;
  payload.status = payload.status === "archived" ? "published" : payload.status;
  payload.isActive = true;

  return NutritionPlan.create(payload);
};

export const duplicateMealProgram = async ({ planId, adminId, asTemplate = true }) => {
  const source = await NutritionPlan.findById(planId);
  if (!source) {
    throw new AppError("Meal program not found.", httpStatus.NOT_FOUND);
  }

  const payload = clonePlain(source);
  payload.title = `${source.title} (Copy)`;
  payload.isTemplate = Boolean(asTemplate);
  payload.assignedUser = asTemplate ? null : source.assignedUser;
  payload.sourceTemplate = source.isTemplate ? source._id : source.sourceTemplate || null;
  payload.createdBy = adminId || source.createdBy;
  payload.updatedBy = adminId || null;
  payload.status = "draft";
  payload.isActive = true;

  return NutritionPlan.create(payload);
};
