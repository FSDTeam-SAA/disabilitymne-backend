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
import { WorkoutLog } from "../models/workoutLog.model.js";
import { WorkoutSession } from "../models/workoutSession.model.js";
import {
  PLAN_KEYS,
  SUBSCRIPTION_PLANS,
  getPlanKeyVariants,
  normalizePlanKey as normalizeSubscriptionPlanKey,
} from "../constants/subscriptionPlans.js";
import { ensureDefaultPlansIfEmpty } from "../services/subscriptionPlan.service.js";
import { mergeUploadedMediaIntoBody } from "../utils/uploadedMedia.js";

const ACCOUNT_STATUSES = new Set(["active", "deactivated", "suspended"]);
const USER_ROLES = new Set(["user", "admin"]);
const SUPPORT_TICKET_STATUSES = new Set(["open", "in_progress", "resolved", "closed"]);
const WORKOUT_EXPERIENCE_LEVELS = new Set(["easy", "intermediate", "very_hard"]);
const PROFILE_IMAGE_FIELDS = ["profileImage", "avatar", "image"];

const PLAN_LABELS = {
  monthly: "Monthly user",
  quarterly: "Quarterly user",
  annual: "Annual user",
  premium: "Premium user",
};

const PLAN_FILTERS = {
  monthly: getPlanKeyVariants("monthly"),
  quarterly: getPlanKeyVariants("quarterly"),
  annual: getPlanKeyVariants("annual"),
  premium: getPlanKeyVariants("premium"),
};

const ALL_PLAN_FILTER_KEYS = [...new Set(Object.values(PLAN_FILTERS).flat())];

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

const parseDate = (value, fieldName) => {
  const raw = asString(value);
  if (!raw) return null;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(`${fieldName} must be a valid date.`, httpStatus.BAD_REQUEST);
  }

  return parsed;
};

const normalizePlanKey = (value, required = true) => {
  const normalizedKey = normalizeSubscriptionPlanKey(value);
  if (!normalizedKey) {
    if (required) {
      throw new AppError("plan key is required.", httpStatus.BAD_REQUEST);
    }
    return "";
  }

  if (!PLAN_KEYS.includes(normalizedKey)) {
    throw new AppError(`Unsupported plan key "${asString(value)}".`, httpStatus.BAD_REQUEST);
  }

  return normalizedKey;
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

const normalizeRole = (value) => {
  const role = asString(value).toLowerCase();
  if (!USER_ROLES.has(role)) {
    throw new AppError("role must be one of: user, admin.", httpStatus.BAD_REQUEST);
  }

  return role;
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
  const key = normalizeSubscriptionPlanKey(user.selectedPlan);
  return PLAN_LABELS[key] || "No plan";
};

const toUserRow = (user) => ({
  id: user._id,
  name: `${asString(user.firstName)} ${asString(user.lastName)}`.trim() || user.firstName,
  email: user.email,
  phone: user.phone || "",
  createdAt: user.createdAt,
  subscription: subscriptionBadge(user),
  selectedPlan: normalizeSubscriptionPlanKey(user.selectedPlan) || null,
  mobilityType: user.mobilityType || "",
  status: user.accountStatus || (user.isActive ? "active" : "deactivated"),
  isActive: Boolean(user.isActive),
  isSponsored: Boolean(user.isSponsored),
  sponsorshipNote: asString(user?.sponsorship?.note) || "",
  role: user.role || "user",
});

const toPlanResponse = (plan) => ({
  key: normalizeSubscriptionPlanKey(plan.key) || String(plan.key || "").toLowerCase(),
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

const toYmd = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const toAdminWorkoutProgressLogRow = (log) => ({
  id: log._id,
  user:
    log.user && typeof log.user === "object"
      ? {
          id: log.user._id,
          firstName: log.user.firstName || "",
          lastName: log.user.lastName || "",
          email: log.user.email || "",
        }
      : null,
  program:
    log.program && typeof log.program === "object"
      ? {
          id: log.program._id,
          programName: log.program.programName || "",
        }
      : log.program || null,
  exercise:
    log.exercise && typeof log.exercise === "object"
      ? {
          id: log.exercise._id,
          exerciseName: log.exercise.exerciseName || log.exerciseName || "",
        }
      : log.exercise
      ? {
          id: log.exercise,
          exerciseName: log.exerciseName || "",
        }
      : null,
  sessionId: log.sessionId || null,
  dayIndex: log.dayIndex || null,
  weekStartDate: log.weekStartDate || null,
  sets: log.sets || [],
  caloriesBurned: Number(log.caloriesBurned || 0),
  durationMinutes: Number(log.durationMinutes || 0),
  trainingVolume: Number(log.trainingVolume || 0),
  completedAt: log.completedAt,
  createdAt: log.createdAt,
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

  let planDoc = await SubscriptionPlan.findOne({ key: { $in: getPlanKeyVariants(planKey) } });
  if (planDoc && planDoc.key !== planKey) {
    const existingCanonical = await SubscriptionPlan.findOne({ key: planKey });
    if (!existingCanonical) {
      planDoc.key = planKey;
      await planDoc.save({ validateBeforeSave: false });
    } else {
      planDoc = existingCanonical;
    }
  }

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
      isPopular: defaultPlan.key === "premium",
      sortOrder: PLAN_KEYS.indexOf(defaultPlan.key) + 1,
      isActive: true,
    });
  }

  return planDoc;
};

const toCanonicalPlanList = (plans = []) => {
  const byKey = new Map();

  for (const plan of plans) {
    const canonicalKey = normalizeSubscriptionPlanKey(plan.key) || String(plan.key || "").toLowerCase();
    if (!canonicalKey) continue;

    const rawKey = String(plan.key || "").toLowerCase();
    const score = (rawKey === canonicalKey ? 2 : 0) + (plan.isActive ? 1 : 0);

    const existing = byKey.get(canonicalKey);
    if (!existing || score > existing.score) {
      byKey.set(canonicalKey, { score, plan });
      continue;
    }

    if (score === existing.score) {
      const existingUpdatedAt = new Date(existing.plan.updatedAt || existing.plan.createdAt || 0).getTime();
      const currentUpdatedAt = new Date(plan.updatedAt || plan.createdAt || 0).getTime();
      if (currentUpdatedAt > existingUpdatedAt) {
        byKey.set(canonicalKey, { score, plan });
      }
    }
  }

  return Array.from(byKey.values())
    .map((item) => item.plan)
    .sort((a, b) => {
      const sortOrderDiff = Number(a.sortOrder || 0) - Number(b.sortOrder || 0);
      if (sortOrderDiff !== 0) return sortOrderDiff;
      return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
    });
};

export const getDashboardOverview = catchAsync(async (req, res) => {
  const [totalUsers, monthlyUsers, quarterlyUsers, annualUsers, premiumUsers, revenueAgg, recentUsers] = await Promise.all([
    User.countDocuments({ role: "user" }),
    User.countDocuments({ role: "user", selectedPlan: { $in: PLAN_FILTERS.monthly } }),
    User.countDocuments({ role: "user", selectedPlan: { $in: PLAN_FILTERS.quarterly } }),
    User.countDocuments({ role: "user", selectedPlan: { $in: PLAN_FILTERS.annual } }),
    User.countDocuments({ role: "user", selectedPlan: { $in: PLAN_FILTERS.premium } }),
    Payment.aggregate([{ $match: { status: "succeeded" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
    User.find({ role: "user" })
      .sort({ createdAt: -1 })
      .limit(8)
      .select("firstName lastName email phone createdAt selectedPlan mobilityType accountStatus isActive isSponsored sponsorship role"),
  ]);

  const totalRevenue = revenueAgg[0]?.total || 0;

  const surveyAgg = await User.aggregate([
    { $match: { role: "user", selectedPlan: { $in: ALL_PLAN_FILTER_KEYS } } },
    { $group: { _id: "$selectedPlan", count: { $sum: 1 } } },
  ]);

  const surveyCountByPlan = new Map();
  for (const item of surveyAgg) {
    const normalizedKey = normalizeSubscriptionPlanKey(item._id);
    if (!normalizedKey) {
      continue;
    }

    surveyCountByPlan.set(normalizedKey, (surveyCountByPlan.get(normalizedKey) || 0) + item.count);
  }

  const surveyTotal = [...surveyCountByPlan.values()].reduce((sum, count) => sum + count, 0);
  const survey = PLAN_KEYS.map((key) => {
    const count = surveyCountByPlan.get(key) || 0;
    const percentage = surveyTotal > 0 ? Number(((count / surveyTotal) * 100).toFixed(2)) : 0;
    return { key, label: PLAN_LABELS[key] || key, count, percentage };
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
        totalQuarterlyUsers: quarterlyUsers,
        totalAnnualUsers: annualUsers,
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

  const filter = {};

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
    filter.selectedPlan = { $in: getPlanKeyVariants(normalizePlanKey(req.query.subscription)) };
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

  const isSponsoredFilter = parseBoolean(req.query.isSponsored, "isSponsored");
  if (isSponsoredFilter !== undefined) {
    filter.isSponsored = isSponsoredFilter;
  }

  const allowedSortFields = new Set(["createdAt", "firstName", "email", "selectedPlan", "accountStatus"]);
  const sortField = allowedSortFields.has(asString(req.query.sortBy)) ? asString(req.query.sortBy) : "createdAt";
  const sortOrder = asString(req.query.sortOrder).toLowerCase() === "asc" ? 1 : -1;

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ [sortField]: sortOrder, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("firstName lastName email phone createdAt selectedPlan mobilityType accountStatus isActive isSponsored sponsorship role"),
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

export const getAdminWorkoutProgress = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const startDate = parseDate(req.query.startDate, "startDate");
  const endDate = parseDate(req.query.endDate, "endDate");
  if (startDate && endDate && startDate > endDate) {
    throw new AppError("startDate must be earlier than or equal to endDate.", httpStatus.BAD_REQUEST);
  }

  const completedAtFilter = {};
  if (startDate) {
    completedAtFilter.$gte = startDate;
  }
  if (endDate) {
    const inclusiveEnd = new Date(endDate);
    inclusiveEnd.setHours(23, 59, 59, 999);
    completedAtFilter.$lte = inclusiveEnd;
  }

  const sessionFilter = { status: "completed" };
  const logFilter = {};

  if (Object.keys(completedAtFilter).length > 0) {
    sessionFilter.completedAt = completedAtFilter;
    logFilter.completedAt = completedAtFilter;
  }

  if (req.query.userId) {
    const userId = parseObjectId(req.query.userId, "userId");
    sessionFilter.user = userId;
    logFilter.user = userId;
  }

  if (req.query.programId) {
    const programId = parseObjectId(req.query.programId, "programId");
    sessionFilter.program = programId;
    logFilter.program = programId;
  }

  if (req.query.exerciseId) {
    logFilter.exercise = parseObjectId(req.query.exerciseId, "exerciseId");
  }

  const [sessions, logs, total, strengthRows] = await Promise.all([
    WorkoutSession.find(sessionFilter)
      .select("weekStartDate totals scheduledExercises completedExercises completedAt")
      .lean(),
    WorkoutLog.find(logFilter)
      .sort({ completedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "firstName lastName email")
      .populate("program", "programName")
      .populate("exercise", "exerciseName"),
    WorkoutLog.countDocuments(logFilter),
    WorkoutLog.aggregate([
      {
        $match: {
          ...logFilter,
          exercise: { ...(logFilter.exercise ? { $eq: logFilter.exercise } : { $ne: null }) },
        },
      },
      {
        $unwind: {
          path: "$sets",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $group: {
          _id: {
            weekStartDate: "$weekStartDate",
            exercise: "$exercise",
          },
          exerciseName: { $first: "$exerciseName" },
          bestWeightKg: { $max: { $ifNull: ["$sets.weightKg", 0] } },
          bestReps: { $max: { $ifNull: ["$sets.reps", 0] } },
          totalVolume: {
            $sum: {
              $multiply: [
                { $ifNull: ["$sets.reps", 0] },
                { $ifNull: ["$sets.weightKg", 0] },
              ],
            },
          },
        },
      },
      { $sort: { "_id.weekStartDate": 1, exerciseName: 1 } },
    ]),
  ]);

  const adherenceByWeekMap = new Map();
  for (const session of sessions) {
    const weekKey = toYmd(session.weekStartDate || session.completedAt);
    if (!weekKey) continue;

    const scheduledExercises = Number(session?.totals?.scheduledExercises || session?.scheduledExercises?.length || 0);
    const completedExercises = Number(session?.totals?.completedExercises || session?.completedExercises?.length || 0);
    const current = adherenceByWeekMap.get(weekKey) || {
      weekStartDate: weekKey,
      scheduledExercises: 0,
      completedExercises: 0,
      adherencePercent: 0,
    };

    current.scheduledExercises += scheduledExercises;
    current.completedExercises += completedExercises;
    current.adherencePercent = current.scheduledExercises > 0
      ? Number(((current.completedExercises / current.scheduledExercises) * 100).toFixed(2))
      : 0;

    adherenceByWeekMap.set(weekKey, current);
  }

  const adherenceByWeek = [...adherenceByWeekMap.values()].sort((a, b) =>
    new Date(a.weekStartDate).getTime() - new Date(b.weekStartDate).getTime()
  );

  const strengthTrend = strengthRows.map((row) => ({
    weekStartDate: row._id?.weekStartDate || null,
    exerciseId: row._id?.exercise || null,
    exerciseName: row.exerciseName || "",
    bestWeightKg: Number(Number(row.bestWeightKg || 0).toFixed(2)),
    bestReps: Number(row.bestReps || 0),
    totalVolume: Number(Number(row.totalVolume || 0).toFixed(2)),
  }));

  const totalScheduledExercises = adherenceByWeek.reduce((sum, row) => sum + Number(row.scheduledExercises || 0), 0);
  const totalCompletedExercises = adherenceByWeek.reduce((sum, row) => sum + Number(row.completedExercises || 0), 0);
  const totalTrainingVolume = strengthTrend.reduce((sum, row) => sum + Number(row.totalVolume || 0), 0);

  res.status(httpStatus.OK).json({
    success: true,
    data: {
      summary: {
        completedWorkoutDays: sessions.length,
        scheduledExercises: totalScheduledExercises,
        completedExercises: totalCompletedExercises,
        adherencePercent: totalScheduledExercises > 0
          ? Number(((totalCompletedExercises / totalScheduledExercises) * 100).toFixed(2))
          : 0,
        totalTrainingVolume: Number(totalTrainingVolume.toFixed(2)),
      },
      series: {
        adherenceByWeek,
        strengthTrend,
      },
      recentLogs: logs.map(toAdminWorkoutProgressLogRow),
    },
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  });
});

export const createAdminUser = catchAsync(async (req, res) => {
  const firstName = asString(req.body.firstName);
  const lastName = asString(req.body.lastName);
  const phone = asString(req.body.phone);
  const sponsorshipNote = asString(req.body.sponsorshipNote || req.body.note);
  const email = asString(req.body.email).toLowerCase();
  const temporaryPassword = asString(
    req.body.temporaryPassword || req.body.tempPassword || req.body.password
  );
  const planKey = normalizePlanKey(req.body.planKey);

  if (!firstName) {
    throw new AppError("firstName is required.", httpStatus.BAD_REQUEST);
  }

  if (!email) {
    throw new AppError("email is required.", httpStatus.BAD_REQUEST);
  }

  if (!temporaryPassword) {
    throw new AppError("temporaryPassword is required.", httpStatus.BAD_REQUEST);
  }

  if (temporaryPassword.length < 8) {
    throw new AppError("temporaryPassword must be at least 8 characters.", httpStatus.BAD_REQUEST);
  }

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    throw new AppError("User with this email already exists.", httpStatus.CONFLICT);
  }

  const plan = await ensurePlanDoc(planKey);
  if (!plan.isActive) {
    throw new AppError("Selected plan must be active.", httpStatus.BAD_REQUEST);
  }
  const canonicalPlanKey = normalizeSubscriptionPlanKey(plan.key) || planKey;
  const now = new Date();

  const user = await User.create({
    role: "user",
    firstName,
    lastName,
    email,
    phone,
    password: temporaryPassword,
    selectedPlan: canonicalPlanKey,
    subscriptionStatus: "active",
    trialActivatedAt: null,
    trialEndsAt: null,
    subscriptionStartedAt: now,
    subscriptionEndsAt: null,
    accountStatus: "active",
    isActive: true,
    isSponsored: true,
    sponsorship: {
      note: sponsorshipNote,
      grantedBy: req.user._id,
      grantedAt: now,
    },
  });

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Sponsored user created successfully.",
    data: toUserRow(user),
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

export const updateAdminUserRole = catchAsync(async (req, res) => {
  const { userId } = req.params;

  if (!mongoose.isValidObjectId(userId)) {
    throw new AppError("Invalid user id.", httpStatus.BAD_REQUEST);
  }

  if (userId === req.user._id.toString()) {
    throw new AppError("You cannot change your own role.", httpStatus.BAD_REQUEST);
  }

  const role = normalizeRole(req.body.role);

  const user = await User.findById(userId).select("+refreshTokenHash +refreshTokenExpiresAt");
  if (!user) {
    throw new AppError("User not found.", httpStatus.NOT_FOUND);
  }

  user.role = role;
  user.clearRefreshToken();
  await user.save({ validateBeforeSave: false });

  res.status(httpStatus.OK).json({
    success: true,
    message: "User role updated successfully.",
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
  const canonicalPlans = toCanonicalPlanList(plans);

  res.status(httpStatus.OK).json({
    success: true,
    data: canonicalPlans.map(toPlanResponse),
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
  const plan = await SubscriptionPlan.findOne({ key: { $in: getPlanKeyVariants(planKey) }, isActive: true });
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

