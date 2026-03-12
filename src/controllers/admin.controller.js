import mongoose from "mongoose";
import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { serializeUser } from "../utils/serializeUser.js";
import { User } from "../models/user.model.js";
import { Payment } from "../models/payment.model.js";
import { SubscriptionPlan } from "../models/subscriptionPlan.model.js";
import { SupportTicket } from "../models/supportTicket.model.js";
import { WorkoutExperience } from "../models/workoutExperience.model.js";
import { PLAN_KEYS, SUBSCRIPTION_PLANS } from "../constants/subscriptionPlans.js";
import { ensureDefaultPlansIfEmpty } from "../services/subscriptionPlan.service.js";
import { mergeUploadedMediaIntoBody } from "../utils/uploadedMedia.js";

const ACCOUNT_STATUSES = new Set(["active", "deactivated", "suspended"]);
const SUPPORT_TICKET_STATUSES = new Set(["open", "in_progress", "resolved", "closed"]);
const WORKOUT_EXPERIENCE_LEVELS = new Set(["easy", "intermediate", "very_hard"]);
const PROFILE_IMAGE_FIELDS = ["profileImage", "avatar", "image"];

const PLAN_LABELS = {
  free_trial: "Free Trial user",
  monthly_plan: "Monthly user",
  six_month_plan: "Six Month user",
  premium_plan: "Premium user",
};

const parseMaybeJson = (value) => {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return value;

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
};

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const escapeRegex = (input) => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parsePage = (value) => {
  const page = Number(value || 1);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
};

const parseLimit = (value, defaultValue = 20, maxValue = 100) => {
  const limit = Number(value || defaultValue);
  if (!Number.isFinite(limit) || limit <= 0) return defaultValue;
  return Math.min(Math.floor(limit), maxValue);
};

const parseNumber = (value, fieldName, min = 0, required = false) => {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new AppError(`${fieldName} is required.`, httpStatus.BAD_REQUEST);
    }
    return undefined;
  }

  let numeric = value;
  if (typeof value === "string") {
    const matched = value.match(/-?\d+(\.\d+)?/);
    if (!matched) {
      throw new AppError(`${fieldName} must be numeric.`, httpStatus.BAD_REQUEST);
    }
    numeric = matched[0];
  }

  const parsed = Number(numeric);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new AppError(`${fieldName} must be a number >= ${min}.`, httpStatus.BAD_REQUEST);
  }

  return parsed;
};

const parseBoolean = (value, fieldName) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;

  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase().trim();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  throw new AppError(`${fieldName} must be a boolean.`, httpStatus.BAD_REQUEST);
};

const parseObjectId = (value, fieldName) => {
  const id = asString(value);
  if (!id) return null;

  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(`${fieldName} must be a valid id.`, httpStatus.BAD_REQUEST);
  }

  return id;
};

const normalizePlanKey = (value, required = true) => {
  const key = asString(value).toLowerCase();
  if (!key) {
    if (required) {
      throw new AppError("plan key is required.", httpStatus.BAD_REQUEST);
    }
    return "";
  }

  if (!PLAN_KEYS.includes(key)) {
    throw new AppError(`Unsupported plan key "${key}".`, httpStatus.BAD_REQUEST);
  }

  return key;
};

const normalizeFeatures = (value) => {
  const parsed = parseMaybeJson(value);

  if (Array.isArray(parsed)) {
    return parsed.map((item) => asString(item)).filter(Boolean);
  }

  if (typeof parsed === "string") {
    return parsed
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
};

const normalizeAccountStatus = (value) => {
  const status = asString(value).toLowerCase();
  if (!ACCOUNT_STATUSES.has(status)) {
    throw new AppError("accountStatus must be one of: active, deactivated, suspended.", httpStatus.BAD_REQUEST);
  }

  return status;
};

const normalizeProfileImage = (value) => {
  if (value === null || value === "") {
    return null;
  }

  if (typeof value === "string") {
    const url = asString(value);
    return url
      ? {
        url,
        publicId: "",
        mimetype: "",
        size: 0,
      }
      : null;
  }

  if (typeof value !== "object") {
    throw new AppError("profileImage must be a string URL or media object.", httpStatus.BAD_REQUEST);
  }

  const url = asString(value.url || value.path || value.secure_url);
  if (!url) {
    throw new AppError("profileImage.url is required.", httpStatus.BAD_REQUEST);
  }

  const size = Number(value.size);

  return {
    url,
    publicId: asString(value.publicId || value.public_id || value.filename),
    mimetype: asString(value.mimetype || value.resource_type || value.format),
    size: Number.isFinite(size) && size > 0 ? size : 0,
  };
};

const formatCurrencyAmount = (amount) => Number(amount || 0).toFixed(2);

const buildMonthLabels = (months = 12) => {
  const labels = [];
  const now = new Date();

  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    labels.push({
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      label: d.toLocaleString("en-US", { month: "short" }),
    });
  }

  return labels;
};

const subscriptionBadge = (user) => {
  const key = user.selectedPlan || "free_trial";
  return PLAN_LABELS[key] || "Free Trial user";
};

const toUserRow = (user) => ({
  id: user._id,
  name: `${asString(user.firstName)} ${asString(user.lastName)}`.trim() || user.firstName,
  email: user.email,
  phone: user.phone || "",
  createdAt: user.createdAt,
  subscription: subscriptionBadge(user),
  selectedPlan: user.selectedPlan || "free_trial",
  mobilityType: user.mobilityType || "",
  status: user.accountStatus || (user.isActive ? "active" : "deactivated"),
  isActive: Boolean(user.isActive),
});

const toPlanResponse = (plan) => ({
  key: plan.key,
  name: plan.name,
  price: plan.price,
  currency: plan.currency,
  durationLabel: plan.durationLabel,
  durationMonths: plan.durationMonths,
  trialDays: plan.trialDays,
  features: plan.features || [],
  isPopular: Boolean(plan.isPopular),
  sortOrder: plan.sortOrder,
  isActive: Boolean(plan.isActive),
  deletedAt: plan.deletedAt || null,
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
});

const normalizeSupportTicketStatus = (value) => {
  const status = asString(value).toLowerCase();
  if (!SUPPORT_TICKET_STATUSES.has(status)) {
    throw new AppError("status must be one of: open, in_progress, resolved, closed.", httpStatus.BAD_REQUEST);
  }

  return status;
};

const normalizeWorkoutExperienceLevel = (value) => {
  const normalized = asString(value).toLowerCase().replace(/\s+/g, "_");
  if (!WORKOUT_EXPERIENCE_LEVELS.has(normalized)) {
    throw new AppError("experienceLevel must be one of: easy, intermediate, very_hard.", httpStatus.BAD_REQUEST);
  }

  return normalized;
};

const toAdminSupportTicketResponse = (ticket) => ({
  id: ticket._id,
  user: ticket.user && typeof ticket.user === "object"
    ? {
      id: ticket.user._id,
      firstName: ticket.user.firstName || "",
      lastName: ticket.user.lastName || "",
      email: ticket.user.email || ticket.email,
    }
    : null,
  email: ticket.email,
  subject: ticket.subject,
  description: ticket.description,
  status: ticket.status,
  adminResponse: ticket.adminResponse || "",
  resolvedAt: ticket.resolvedAt || null,
  createdAt: ticket.createdAt,
  updatedAt: ticket.updatedAt,
});

const toAdminWorkoutExperienceResponse = (experience) => ({
  id: experience._id,
  user:
    experience.user && typeof experience.user === "object"
      ? {
        id: experience.user._id,
        firstName: experience.user.firstName || "",
        lastName: experience.user.lastName || "",
        email: experience.user.email || "",
      }
      : null,
  program:
    experience.program && typeof experience.program === "object"
      ? {
        id: experience.program._id,
        programName: experience.program.programName || "",
      }
      : experience.program || null,
  experienceLevel: experience.experienceLevel,
  notes: experience.notes || "",
  completedAt: experience.completedAt,
  createdAt: experience.createdAt,
  updatedAt: experience.updatedAt,
});

const getAdminProfileBodyFromRequest = (req) => {
  const payload = mergeUploadedMediaIntoBody(req.body, req.files, [{ target: "profileImage", fieldNames: PROFILE_IMAGE_FIELDS }]);

  if (Array.isArray(payload.profileImage)) {
    payload.profileImage = payload.profileImage[0] || null;
  }

  return payload;
};

const getDefaultPlanByKey = (planKey) => SUBSCRIPTION_PLANS.find((plan) => plan.key === planKey);

const ensurePlanDoc = async (planKey) => {
  await ensureDefaultPlansIfEmpty();

  let planDoc = await SubscriptionPlan.findOne({ key: planKey });
  if (!planDoc) {
    const defaultPlan = getDefaultPlanByKey(planKey);
    if (!defaultPlan) {
      throw new AppError("Plan not found.", httpStatus.NOT_FOUND);
    }

    planDoc = await SubscriptionPlan.create({
      key: defaultPlan.key,
      name: defaultPlan.name,
      price: defaultPlan.price,
      currency: defaultPlan.currency || "USD",
      durationLabel: defaultPlan.trialDays ? `${defaultPlan.trialDays} days` : `${defaultPlan.durationMonths || 1} months`,
      durationMonths: defaultPlan.durationMonths || 0,
      trialDays: defaultPlan.trialDays || 0,
      features: defaultPlan.features || [],
      isPopular: defaultPlan.key === "premium_plan",
      sortOrder: PLAN_KEYS.indexOf(defaultPlan.key) + 1,
      isActive: true,
    });
  }

  return planDoc;
};

export const getDashboardOverview = catchAsync(async (req, res) => {
  const [totalUsers, monthlyUsers, sixMonthUsers, premiumUsers, revenueAgg, recentUsers] = await Promise.all([
    User.countDocuments({ role: "user" }),
    User.countDocuments({ role: "user", selectedPlan: "monthly_plan" }),
    User.countDocuments({ role: "user", selectedPlan: "six_month_plan" }),
    User.countDocuments({ role: "user", selectedPlan: "premium_plan" }),
    Payment.aggregate([{ $match: { status: "succeeded" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
    User.find({ role: "user" })
      .sort({ createdAt: -1 })
      .limit(8)
      .select("firstName lastName email phone createdAt selectedPlan mobilityType accountStatus isActive"),
  ]);

  const totalRevenue = revenueAgg[0]?.total || 0;

  const surveyAgg = await User.aggregate([
    { $match: { role: "user", selectedPlan: { $in: PLAN_KEYS } } },
    { $group: { _id: "$selectedPlan", count: { $sum: 1 } } },
  ]);

  const surveyTotal = surveyAgg.reduce((sum, item) => sum + item.count, 0);
  const survey = PLAN_KEYS.map((key) => {
    const found = surveyAgg.find((item) => item._id === key);
    const count = found ? found.count : 0;
    const percentage = surveyTotal > 0 ? Number(((count / surveyTotal) * 100).toFixed(2)) : 0;
    return { key, label: PLAN_LABELS[key], count, percentage };
  });

  const monthLabels = buildMonthLabels(12);
  const monthStart = new Date(monthLabels[0].year, monthLabels[0].month - 1, 1);

  const revenueByMonthAgg = await Payment.aggregate([
    { $match: { status: "succeeded", createdAt: { $gte: monthStart } } },
    {
      $group: {
        _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
        total: { $sum: "$amount" },
      },
    },
  ]);

  const earningsSeries = monthLabels.map((month) => {
    const found = revenueByMonthAgg.find((item) => item._id.year === month.year && item._id.month === month.month);
    return {
      label: month.label,
      revenue: Number((found?.total || 0).toFixed(2)),
    };
  });

  res.status(httpStatus.OK).json({
    success: true,
    data: {
      totals: {
        totalUsers,
        totalMonthlyUsers: monthlyUsers,
        totalSixMonthUsers: sixMonthUsers,
        totalPremiumUsers: premiumUsers,
        totalRevenue: Number(totalRevenue.toFixed(2)),
        totalRevenueDisplay: formatCurrencyAmount(totalRevenue),
      },
      earningsSeries,
      subscriptionSurvey: survey,
      recentUsers: recentUsers.map(toUserRow),
    },
  });
});

export const getAdminUsers = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = { role: "user" };

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.$or = [
      { firstName: pattern },
      { lastName: pattern },
      { email: pattern },
      { phone: pattern },
    ];
  }

  if (req.query.subscription) {
    filter.selectedPlan = normalizePlanKey(req.query.subscription);
  }

  if (req.query.mobilityType) {
    filter.mobilityType = asString(req.query.mobilityType);
  }

  if (req.query.status) {
    const status = normalizeAccountStatus(req.query.status);
    if (status === "active") {
      filter.$and = [...(filter.$and || []), { $or: [{ accountStatus: "active" }, { accountStatus: { $exists: false } }] }];
      filter.isActive = true;
    } else {
      filter.accountStatus = status;
    }
  }

  const allowedSortFields = new Set(["createdAt", "firstName", "email", "selectedPlan", "accountStatus"]);
  const sortField = allowedSortFields.has(asString(req.query.sortBy)) ? asString(req.query.sortBy) : "createdAt";
  const sortOrder = asString(req.query.sortOrder).toLowerCase() === "asc" ? 1 : -1;

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ [sortField]: sortOrder, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("firstName lastName email phone createdAt selectedPlan mobilityType accountStatus isActive"),
    User.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: users.map(toUserRow),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  });
});

export const getAdminSupportTickets = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;
  const filter = {};

  if (req.query.status) {
    filter.status = normalizeSupportTicketStatus(req.query.status);
  }

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.$or = [
      { email: pattern },
      { subject: pattern },
      { description: pattern },
      { adminResponse: pattern },
    ];
  }

  const [tickets, total] = await Promise.all([
    SupportTicket.find(filter)
      .sort({ createdAt: -1, updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "firstName lastName email"),
    SupportTicket.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: tickets.map(toAdminSupportTicketResponse),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  });
});

export const getAdminSupportTicketById = catchAsync(async (req, res) => {
  const { ticketId } = req.params;
  if (!mongoose.isValidObjectId(ticketId)) {
    throw new AppError("Invalid support ticket id.", httpStatus.BAD_REQUEST);
  }

  const ticket = await SupportTicket.findById(ticketId).populate("user", "firstName lastName email");
  if (!ticket) {
    throw new AppError("Support ticket not found.", httpStatus.NOT_FOUND);
  }

  res.status(httpStatus.OK).json({
    success: true,
    data: toAdminSupportTicketResponse(ticket),
  });
});

export const updateAdminSupportTicket = catchAsync(async (req, res) => {
  const { ticketId } = req.params;
  if (!mongoose.isValidObjectId(ticketId)) {
    throw new AppError("Invalid support ticket id.", httpStatus.BAD_REQUEST);
  }

  const ticket = await SupportTicket.findById(ticketId).populate("user", "firstName lastName email");
  if (!ticket) {
    throw new AppError("Support ticket not found.", httpStatus.NOT_FOUND);
  }

  if (Object.hasOwn(req.body, "status")) {
    ticket.status = normalizeSupportTicketStatus(req.body.status);
  }

  if (Object.hasOwn(req.body, "adminResponse")) {
    ticket.adminResponse = asString(req.body.adminResponse);
  }

  if (ticket.status === "resolved" || ticket.status === "closed") {
    ticket.resolvedAt = ticket.resolvedAt || new Date();
  } else {
    ticket.resolvedAt = null;
  }

  await ticket.save();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Support ticket updated successfully.",
    data: toAdminSupportTicketResponse(ticket),
  });
});

export const getAdminWorkoutExperiences = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;
  const filter = {};

  if (req.query.experienceLevel || req.query.difficulty) {
    filter.experienceLevel = normalizeWorkoutExperienceLevel(req.query.experienceLevel || req.query.difficulty);
  }

  if (req.query.userId) {
    filter.user = parseObjectId(req.query.userId, "userId");
  }

  if (req.query.programId) {
    filter.program = parseObjectId(req.query.programId, "programId");
  }

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.notes = pattern;
  }

  const [experiences, total] = await Promise.all([
    WorkoutExperience.find(filter)
      .sort({ completedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "firstName lastName email")
      .populate("program", "programName"),
    WorkoutExperience.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: experiences.map(toAdminWorkoutExperienceResponse),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  });
});

export const getAdminWorkoutExperienceById = catchAsync(async (req, res) => {
  const { experienceId } = req.params;
  if (!mongoose.isValidObjectId(experienceId)) {
    throw new AppError("Invalid workout experience id.", httpStatus.BAD_REQUEST);
  }

  const experience = await WorkoutExperience.findById(experienceId)
    .populate("user", "firstName lastName email")
    .populate("program", "programName");

  if (!experience) {
    throw new AppError("Workout experience not found.", httpStatus.NOT_FOUND);
  }

  res.status(httpStatus.OK).json({
    success: true,
    data: toAdminWorkoutExperienceResponse(experience),
  });
});

export const updateAdminUserStatus = catchAsync(async (req, res) => {
  const { userId } = req.params;

  if (!mongoose.isValidObjectId(userId)) {
    throw new AppError("Invalid user id.", httpStatus.BAD_REQUEST);
  }

  const accountStatus = normalizeAccountStatus(req.body.accountStatus);

  const user = await User.findById(userId).select("+refreshTokenHash +refreshTokenExpiresAt");
  if (!user || user.role !== "user") {
    throw new AppError("User not found.", httpStatus.NOT_FOUND);
  }

  user.accountStatus = accountStatus;
  user.isActive = accountStatus === "active";

  if (!user.isActive) {
    user.clearRefreshToken();
  }

  await user.save({ validateBeforeSave: false });

  res.status(httpStatus.OK).json({
    success: true,
    message: "User status updated successfully.",
    data: toUserRow(user),
  });
});

export const deleteAdminUser = catchAsync(async (req, res) => {
  const { userId } = req.params;

  if (!mongoose.isValidObjectId(userId)) {
    throw new AppError("Invalid user id.", httpStatus.BAD_REQUEST);
  }

  const user = await User.findById(userId).select("+refreshTokenHash +refreshTokenExpiresAt");
  if (!user || user.role !== "user") {
    throw new AppError("User not found.", httpStatus.NOT_FOUND);
  }

  user.accountStatus = "deactivated";
  user.isActive = false;
  user.clearRefreshToken();
  await user.save({ validateBeforeSave: false });

  res.status(httpStatus.OK).json({
    success: true,
    message: "User deactivated successfully.",
  });
});

export const getAdminSettingsProfile = catchAsync(async (req, res) => {
  res.status(httpStatus.OK).json({
    success: true,
    data: serializeUser(req.user),
  });
});

export const updateAdminSettingsProfile = catchAsync(async (req, res) => {
  const admin = await User.findById(req.user._id);
  if (!admin) {
    throw new AppError("Admin not found.", httpStatus.NOT_FOUND);
  }

  const payload = getAdminProfileBodyFromRequest(req);

  const emailInput = asString(payload.email).toLowerCase();
  if (emailInput && emailInput !== admin.email) {
    const existing = await User.findOne({ email: emailInput, _id: { $ne: admin._id } });
    if (existing) {
      throw new AppError("Email is already in use.", httpStatus.CONFLICT);
    }
    admin.email = emailInput;
  }

  if (Object.hasOwn(payload, "firstName")) admin.firstName = asString(payload.firstName);
  if (Object.hasOwn(payload, "lastName")) admin.lastName = asString(payload.lastName);
  if (Object.hasOwn(payload, "phone")) admin.phone = asString(payload.phone);
  if (Object.hasOwn(payload, "bio")) admin.bio = asString(payload.bio);
  if (Object.hasOwn(payload, "profileImage")) admin.profileImage = normalizeProfileImage(payload.profileImage);

  await admin.save();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Profile updated successfully.",
    data: serializeUser(admin),
  });
});

export const updateAdminSettingsPassword = catchAsync(async (req, res) => {
  const { currentPassword, newPassword, confirmNewPassword } = req.body;

  if (!currentPassword || !newPassword || !confirmNewPassword) {
    throw new AppError("currentPassword, newPassword and confirmNewPassword are required.", httpStatus.BAD_REQUEST);
  }

  if (newPassword !== confirmNewPassword) {
    throw new AppError("newPassword and confirmNewPassword do not match.", httpStatus.BAD_REQUEST);
  }

  const admin = await User.findById(req.user._id).select("+password +refreshTokenHash +refreshTokenExpiresAt");
  if (!admin) {
    throw new AppError("Admin not found.", httpStatus.NOT_FOUND);
  }

  const isValid = await admin.comparePassword(currentPassword);
  if (!isValid) {
    throw new AppError("Current password is incorrect.", httpStatus.UNAUTHORIZED);
  }

  admin.password = newPassword;
  admin.clearRefreshToken();
  await admin.save();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Password updated successfully. Please log in again.",
  });
});

export const getAdminSubscriptionPlans = catchAsync(async (req, res) => {
  await ensureDefaultPlansIfEmpty();

  const includeInactive = parseBoolean(req.query.includeInactive, "includeInactive");
  const filter = includeInactive ? {} : { isActive: true };

  const plans = await SubscriptionPlan.find(filter).sort({ sortOrder: 1, createdAt: 1 });

  res.status(httpStatus.OK).json({
    success: true,
    data: plans.map(toPlanResponse),
  });
});

export const createAdminSubscriptionPlan = catchAsync(async (req, res) => {
  const planKey = normalizePlanKey(req.body.key);
  const existingPlan = await SubscriptionPlan.findOne({ key: planKey, isActive: true });
  if (existingPlan) {
    throw new AppError("Plan already exists.", httpStatus.CONFLICT);
  }

  const defaultPlan = getDefaultPlanByKey(planKey);
  const parsedPrice = parseNumber(req.body.price, "price", 0, false);
  const parsedDurationMonths = parseNumber(req.body.durationMonths, "durationMonths", 0, false);
  const parsedTrialDays = parseNumber(req.body.trialDays, "trialDays", 0, false);

  const payload = {
    key: planKey,
    name: asString(req.body.name) || defaultPlan?.name || planKey,
    price: parsedPrice ?? defaultPlan?.price ?? 0,
    currency: asString(req.body.currency || "USD").toUpperCase(),
    durationLabel: asString(req.body.durationLabel || req.body.planDuration),
    durationMonths: parsedDurationMonths ?? defaultPlan?.durationMonths ?? 0,
    trialDays: parsedTrialDays ?? defaultPlan?.trialDays ?? 0,
    features: normalizeFeatures(req.body.features || req.body.planItems),
    isPopular: parseBoolean(req.body.isPopular, "isPopular") || false,
    sortOrder: parseNumber(req.body.sortOrder, "sortOrder", 0, false) || PLAN_KEYS.indexOf(planKey) + 1,
    isActive: true,
    createdBy: req.user._id,
    updatedBy: req.user._id,
  };

  if (!payload.durationLabel) {
    payload.durationLabel = payload.trialDays ? `${payload.trialDays} days` : `${payload.durationMonths || 1} months`;
  }

  if (payload.features.length === 0 && defaultPlan?.features?.length) {
    payload.features = defaultPlan.features;
  }

  if (planKey === "free_trial") {
    payload.price = 0;
    payload.durationMonths = 0;
    payload.trialDays = Math.max(payload.trialDays || 0, 1);
  }

  const plan = await SubscriptionPlan.create(payload);

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Subscription plan created successfully.",
    data: toPlanResponse(plan),
  });
});

export const updateAdminSubscriptionPlan = catchAsync(async (req, res) => {
  const planKey = normalizePlanKey(req.params.planKey);
  const plan = await ensurePlanDoc(planKey);

  if (Object.hasOwn(req.body, "name")) {
    const name = asString(req.body.name);
    if (!name) {
      throw new AppError("name cannot be empty.", httpStatus.BAD_REQUEST);
    }
    plan.name = name;
  }

  if (Object.hasOwn(req.body, "price")) {
    plan.price = parseNumber(req.body.price, "price", 0, true);
  }

  if (Object.hasOwn(req.body, "currency")) {
    const currency = asString(req.body.currency).toUpperCase();
    if (!currency) {
      throw new AppError("currency cannot be empty.", httpStatus.BAD_REQUEST);
    }
    plan.currency = currency;
  }

  if (Object.hasOwn(req.body, "durationLabel") || Object.hasOwn(req.body, "planDuration")) {
    const durationLabel = asString(req.body.durationLabel || req.body.planDuration);
    if (!durationLabel) {
      throw new AppError("durationLabel cannot be empty.", httpStatus.BAD_REQUEST);
    }
    plan.durationLabel = durationLabel;
  }

  if (Object.hasOwn(req.body, "durationMonths")) {
    plan.durationMonths = parseNumber(req.body.durationMonths, "durationMonths", 0, true);
  }

  if (Object.hasOwn(req.body, "trialDays")) {
    plan.trialDays = parseNumber(req.body.trialDays, "trialDays", 0, true);
  }

  if (Object.hasOwn(req.body, "features") || Object.hasOwn(req.body, "planItems")) {
    const features = normalizeFeatures(req.body.features || req.body.planItems);
    if (features.length === 0) {
      throw new AppError("At least one feature is required.", httpStatus.BAD_REQUEST);
    }
    plan.features = features;
  }

  if (Object.hasOwn(req.body, "isPopular")) {
    plan.isPopular = parseBoolean(req.body.isPopular, "isPopular");
  }

  if (Object.hasOwn(req.body, "sortOrder")) {
    plan.sortOrder = parseNumber(req.body.sortOrder, "sortOrder", 0, true);
  }

  if (Object.hasOwn(req.body, "isActive")) {
    plan.isActive = parseBoolean(req.body.isActive, "isActive");
    if (!plan.isActive) {
      plan.deletedAt = new Date();
    } else {
      plan.deletedAt = null;
    }
  }

  if (plan.key === "free_trial") {
    plan.price = 0;
    plan.durationMonths = 0;
    plan.trialDays = Math.max(plan.trialDays || 0, 1);
  }

  plan.updatedBy = req.user._id;
  await plan.save();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Subscription plan updated successfully.",
    data: toPlanResponse(plan),
  });
});

export const deleteAdminSubscriptionPlan = catchAsync(async (req, res) => {
  const planKey = normalizePlanKey(req.params.planKey);
  const plan = await SubscriptionPlan.findOne({ key: planKey, isActive: true });
  if (!plan) {
    throw new AppError("Plan not found.", httpStatus.NOT_FOUND);
  }

  plan.isActive = false;
  plan.deletedAt = new Date();
  plan.updatedBy = req.user._id;
  await plan.save();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Subscription plan deleted successfully.",
  });
});

