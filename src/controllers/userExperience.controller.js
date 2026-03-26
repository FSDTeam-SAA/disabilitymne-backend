import mongoose from "mongoose";
import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { isPremiumActiveUser } from "../utils/access.js";
import { serializeUser } from "../utils/serializeUser.js";
import { collectTrackedProgramIdsForUser, touchUserProgram } from "../utils/userProgramTracker.js";
import { User } from "../models/user.model.js";
import { Program } from "../models/program.model.js";
import { Exercise } from "../models/exercise.model.js";
import { Recipe } from "../models/recipe.model.js";
import { DailyTracker } from "../models/dailyTracker.model.js";
import { WorkoutLog } from "../models/workoutLog.model.js";
import { Notification } from "../models/notification.model.js";
import { SupportTicket } from "../models/supportTicket.model.js";
import { WorkoutExperience } from "../models/workoutExperience.model.js";
import { UserExerciseSetting } from "../models/userExerciseSetting.model.js";
import { WeightLog } from "../models/weightLog.model.js";

const DEFAULT_TRACKER_HABITS = [
  { key: "follow_diet", title: "Follow a Diet", icon: "apple" },
  { key: "no_alcohol", title: "No Alcohol or Cheat Meals", icon: "no_alcohol" },
  { key: "follow_workout", title: "Follow the workout", icon: "workout" },
  { key: "drink_water", title: "Drink 2L Water", icon: "water" },
  { key: "take_progress_picture", title: "Take progress picture", icon: "camera" },
  { key: "read_pages", title: "Read 10 Page", icon: "book" },
];

const DEFAULT_NOTIFICATION_ITEMS = [
  { type: "streak", title: "Streak Alert!", message: "You're on a 7-day streak. Keep it up!" },
  { type: "workout", title: "Time to work out", message: "Your scheduled workout is ready to start" },
  { type: "nutrition", title: "Nutrition reminder", message: "Don't forget to log your lunch today" },
  { type: "achievement", title: "Achievement unlocked!", message: "You earned the 'First Workout' badge" },
  { type: "summary", title: "Weekly Summary", message: "You worked out 5 days this week. Great consistency!" },
];

const RECIPE_TYPES = new Set(["all", "breakfast", "lunch", "dinner", "snack", "meal", "other"]);
const LANGUAGE_CODES = new Set(["en", "sr"]);
const ACCESSIBILITY_KEYS = ["largerText", "highContrast", "reducedMotion", "screenReaderOptimized"];
const WORKOUT_EXPERIENCE_LEVELS = new Set(["easy", "intermediate", "very_hard"]);
const DAY_MS = 24 * 60 * 60 * 1000;

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
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

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

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

const parseDate = (value, fieldName) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(`${fieldName} must be a valid date.`, httpStatus.BAD_REQUEST);
  }
  return date;
};

const parseNumber = (value, fieldName, min = 0, required = false) => {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new AppError(`${fieldName} is required.`, httpStatus.BAD_REQUEST);
    }
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new AppError(`${fieldName} must be a number >= ${min}.`, httpStatus.BAD_REQUEST);
  }

  return parsed;
};

const parseBoolean = (value, fieldName) => {
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

const parseBooleanLike = (value) => {
  if (typeof value === "boolean") {
    return { matched: true, value };
  }

  if (typeof value === "number") {
    if (value === 1) return { matched: true, value: true };
    if (value === 0) return { matched: true, value: false };
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase().trim();
    if (normalized === "true" || normalized === "1") return { matched: true, value: true };
    if (normalized === "false" || normalized === "0") return { matched: true, value: false };
  }

  return { matched: false, value: undefined };
};

const parseObjectId = (value, fieldName) => {
  const id = asString(value);
  if (!id) return null;

  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(`${fieldName} must be a valid id.`, httpStatus.BAD_REQUEST);
  }

  return id;
};

const normalizeWorkoutExperienceLevel = (value) => {
  const normalized = asString(value).toLowerCase().replace(/\s+/g, "_");
  if (!WORKOUT_EXPERIENCE_LEVELS.has(normalized)) {
    throw new AppError("experienceLevel must be one of: easy, intermediate, very_hard.", httpStatus.BAD_REQUEST);
  }

  return normalized;
};

const normalizeSetTemplatesForResponse = (rawSets) =>
  Array.isArray(rawSets)
    ? rawSets
      .filter((set) => set && typeof set === "object")
      .map((set, index) => ({
        setNumber: Number.isFinite(Number(set.setNumber)) && Number(set.setNumber) >= 1 ? Math.floor(Number(set.setNumber)) : index + 1,
        reps: Number.isFinite(Number(set.reps)) ? Number(set.reps) : undefined,
        durationSeconds: Number.isFinite(Number(set.durationSeconds)) ? Number(set.durationSeconds) : undefined,
        weightKg: Number.isFinite(Number(set.weightKg)) && Number(set.weightKg) >= 0 ? Number(set.weightKg) : 1,
      }))
    : [];

const getDurationValueFromTemplate = (template) => {
  if (template.durationSeconds !== undefined && template.durationSeconds !== null && template.durationSeconds !== "") {
    return template.durationSeconds;
  }

  if (template.countdown !== undefined && template.countdown !== null && template.countdown !== "") {
    const parsedBoolean = parseBooleanLike(template.countdown);
    if (!parsedBoolean.matched) {
      return template.countdown;
    }
  }

  if (template.time !== undefined && template.time !== null && template.time !== "") {
    return template.time;
  }

  if (template.seconds !== undefined && template.seconds !== null && template.seconds !== "") {
    return template.seconds;
  }

  return undefined;
};

const getDurationValueFromBody = (body) => {
  if (Object.hasOwn(body, "durationSeconds")) return body.durationSeconds;
  if (Object.hasOwn(body, "time")) return body.time;
  if (Object.hasOwn(body, "seconds")) return body.seconds;

  if (Object.hasOwn(body, "countdown")) {
    const parsedBoolean = parseBooleanLike(body.countdown);
    if (!parsedBoolean.matched) {
      return body.countdown;
    }
  }

  return undefined;
};

const resolveExecutionMode = (executionMode, sets) => {
  if (executionMode === "set_reps" || executionMode === "countdown") {
    return executionMode;
  }

  const normalizedSets = Array.isArray(sets) ? sets : [];
  const hasDuration = normalizedSets.some((set) => set.durationSeconds !== undefined);
  if (hasDuration) {
    return "countdown";
  }

  return "set_reps";
};

const validateSetsMatchExecutionMode = (sets, executionMode, fieldName = "customSets") => {
  if (!Array.isArray(sets)) return;
  if (!executionMode) return;

  for (let index = 0; index < sets.length; index += 1) {
    const set = sets[index] || {};
    const hasReps = set.reps !== undefined && set.reps !== null;
    const hasDuration = set.durationSeconds !== undefined && set.durationSeconds !== null;

    if (executionMode === "countdown") {
      if (!hasDuration) {
        throw new AppError(`${fieldName}[${index}] must include durationSeconds in countdown mode.`, httpStatus.BAD_REQUEST);
      }
      continue;
    }

    if (!hasReps) {
      throw new AppError(`${fieldName}[${index}] must include reps in set_reps mode.`, httpStatus.BAD_REQUEST);
    }

    if (hasDuration) {
      throw new AppError(`${fieldName}[${index}] cannot include durationSeconds in set_reps mode.`, httpStatus.BAD_REQUEST);
    }
  }
};

const parseSetTemplates = (rawValue, fieldName = "customSets") => {
  const value = parseMaybeJson(rawValue);
  if (value === undefined || value === null || value === "") return [];

  let templates = [];
  if (Array.isArray(value)) {
    templates = value;
  } else if (typeof value === "object") {
    templates = [value];
  } else {
    throw new AppError(`${fieldName} must be an array of sets or a set object.`, httpStatus.BAD_REQUEST);
  }

  return templates.map((template, index) => {
    if (!template || typeof template !== "object") {
      throw new AppError(`${fieldName}[${index}] must be an object.`, httpStatus.BAD_REQUEST);
    }

    const setNumber = parseNumber(template.setNumber ?? index + 1, `${fieldName}[${index}].setNumber`, 1, true);
    const reps = parseNumber(template.reps ?? template.targetReps, `${fieldName}[${index}].reps`, 0, false);
    const durationSeconds = parseNumber(
      getDurationValueFromTemplate(template),
      `${fieldName}[${index}].durationSeconds`,
      0,
      false
    );
    const weightKg = parseNumber(template.weightKg ?? template.weight, `${fieldName}[${index}].weightKg`, 0, false) ?? 1;

    if (reps === undefined && durationSeconds === undefined) {
      throw new AppError(
        `${fieldName}[${index}] must include either reps or durationSeconds/countdown.`,
        httpStatus.BAD_REQUEST
      );
    }

    return {
      setNumber: Math.floor(setNumber),
      reps,
      durationSeconds,
      weightKg,
    };
  });
};

const buildUniformSetsFromBody = (body) => {
  const durationValue = getDurationValueFromBody(body);
  const hasSimpleInput =
    Object.hasOwn(body, "setCount") ||
    Object.hasOwn(body, "sets") ||
    Object.hasOwn(body, "reps") ||
    Object.hasOwn(body, "durationSeconds") ||
    Object.hasOwn(body, "time") ||
    Object.hasOwn(body, "seconds") ||
    durationValue !== undefined ||
    Object.hasOwn(body, "weightKg") ||
    Object.hasOwn(body, "weight");

  if (!hasSimpleInput) {
    return null;
  }

  const setsAsJson = parseMaybeJson(body.sets);
  const setCount = parseNumber(
    body.setCount ?? (typeof setsAsJson === "number" ? setsAsJson : undefined) ?? 1,
    "setCount",
    1,
    false
  ) ?? 1;
  const reps = parseNumber(body.reps, "reps", 0, false);
  const durationSeconds = parseNumber(durationValue, "durationSeconds", 0, false);
  const weightKg = parseNumber(body.weightKg ?? body.weight, "weightKg", 0, false) ?? 1;

  if (reps === undefined && durationSeconds === undefined) {
    throw new AppError("Provide either reps or countdown/durationSeconds.", httpStatus.BAD_REQUEST);
  }

  return Array.from({ length: Math.floor(setCount) }, (_, index) => ({
    setNumber: index + 1,
    reps,
    durationSeconds,
    weightKg,
  }));
};

const parseCustomSetsFromBody = (body) => {
  const customSetsInput = body.customSets ?? body.setTemplates ?? body.defaultSets;
  if (customSetsInput !== undefined) {
    return parseSetTemplates(customSetsInput, "customSets");
  }

  const setsInput = parseMaybeJson(body.sets);
  if (Array.isArray(setsInput) || (setsInput && typeof setsInput === "object")) {
    return parseSetTemplates(setsInput, "sets");
  }

  const uniformSets = buildUniformSetsFromBody(body);
  if (uniformSets) {
    return uniformSets;
  }

  throw new AppError(
    "Provide customSets (or setCount with reps/countdown) to save exercise settings.",
    httpStatus.BAD_REQUEST
  );
};

const ensureExerciseAccessibleForUser = async (exerciseId, user) => {
  const exercise = await Exercise.findById(exerciseId).select(
    "exerciseName userType assignedUser status isActive defaultSets executionMode"
  );

  if (!exercise || !exercise.isActive || exercise.status !== "published") {
    throw new AppError("Exercise not found.", httpStatus.NOT_FOUND);
  }

  const isPublicExercise = exercise.userType === "all_user";
  const isAssignedPremiumExercise =
    isPremiumActiveUser(user) &&
    exercise.userType === "premium_user" &&
    exercise.assignedUser &&
    exercise.assignedUser.toString() === user._id.toString();

  if (!isPublicExercise && !isAssignedPremiumExercise) {
    throw new AppError("You are not allowed to access this exercise.", httpStatus.FORBIDDEN);
  }

  return exercise;
};

const toExerciseSettingsResponse = (exercise, customSets = []) => {
  const defaultSets = normalizeSetTemplatesForResponse(exercise.defaultSets);
  const normalizedCustomSets = normalizeSetTemplatesForResponse(customSets);
  const effectiveSets = normalizedCustomSets.length > 0 ? normalizedCustomSets : defaultSets;
  const primarySet = effectiveSets[0] || null;
  const executionMode = resolveExecutionMode(exercise.executionMode, effectiveSets);
  const isCountdown = executionMode === "countdown";

  return {
    exercise: {
      id: exercise._id,
      exerciseName: exercise.exerciseName,
    },
    executionMode,
    hasCustomSettings: normalizedCustomSets.length > 0,
    defaultSets,
    customSets: normalizedCustomSets,
    effectiveSets,
    sets: effectiveSets.length,
    reps: primarySet?.reps ?? null,
    countdown: isCountdown,
    durationSeconds: isCountdown ? primarySet?.durationSeconds ?? null : null,
    weightKg: primarySet?.weightKg ?? 1,
  };
};

const parseTimezoneOffsetMinutes = (value) => {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  const normalizedValue = Array.isArray(value) ? value[0] : value;
  const parsed = Number(normalizedValue);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 14 * 60) {
    throw new AppError("tzOffsetMinutes must be a valid timezone offset in minutes.", httpStatus.BAD_REQUEST);
  }

  return Math.trunc(parsed);
};

const getRequestTimezoneOffsetMinutes = (req) =>
  parseTimezoneOffsetMinutes(req.query.tzOffsetMinutes ?? req.headers["x-timezone-offset-minutes"]);

const shiftDateByOffset = (date, offsetMinutes = 0) =>
  new Date(new Date(date).getTime() + (offsetMinutes * 60 * 1000));

const dateToYmd = (date, offsetMinutes = null) => {
  if (offsetMinutes === null || offsetMinutes === undefined) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const d = shiftDateByOffset(date, offsetMinutes);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getLocalStartOfDayUtc = (date, offsetMinutes = 0) => {
  const shifted = shiftDateByOffset(date, offsetMinutes);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - (offsetMinutes * 60 * 1000));
};

const getLocalStartOfMonthUtc = (date, offsetMinutes = 0) => {
  const shifted = shiftDateByOffset(date, offsetMinutes);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - (offsetMinutes * 60 * 1000));
};

const getLocalWeekKey = (date, offsetMinutes = 0) => {
  const shifted = shiftDateByOffset(date, offsetMinutes);
  const weekday = shifted.getUTCDay() || 7;
  shifted.setUTCDate(shifted.getUTCDate() - weekday + 1);
  return dateToYmd(shifted, 0);
};

const getWeekdayLabel = (date, offsetMinutes = 0) =>
  shiftDateByOffset(date, offsetMinutes).toLocaleString("en-US", { weekday: "short", timeZone: "UTC" });

const getWeekStartDate = (inputDate) => {
  const d = inputDate ? parseDate(inputDate, "weekStartDate") : new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // Sunday = 0
  const diffToMonday = (day + 6) % 7;
  d.setDate(d.getDate() - diffToMonday);
  return d;
};

const getIsoWeekNumber = (inputDate) => {
  const d = new Date(Date.UTC(inputDate.getFullYear(), inputDate.getMonth(), inputDate.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
};

const getWeekdayIndexWithinWeek = (weekStartDate, targetDate = new Date()) => {
  const start = new Date(weekStartDate);
  start.setHours(0, 0, 0, 0);
  const current = new Date(targetDate);
  current.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((current.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays < 0 || diffDays > 6) return 1;
  return diffDays + 1;
};

const buildProgramAccessFilter = (user) => {
  const filter = {
    status: "published",
    isActive: true,
    $or: [{ userType: "normal_user" }],
  };

  if (isPremiumActiveUser(user)) {
    filter.$or.push({ userType: "premium_user", assignedUser: user._id });
  }

  return filter;
};

const buildMyProgramsFilter = (user, trackedProgramIds = []) => {
  const interestConditions = [];

  if (Array.isArray(trackedProgramIds) && trackedProgramIds.length > 0) {
    interestConditions.push({ _id: { $in: trackedProgramIds } });
  }

  if (isPremiumActiveUser(user)) {
    interestConditions.push({ userType: "premium_user", assignedUser: user._id });
  }

  if (interestConditions.length === 0) {
    return null;
  }

  return {
    ...buildProgramAccessFilter(user),
    $and: [{ $or: interestConditions }],
  };
};

const buildRecipeAccessFilter = (user) => {
  const filter = {
    status: "published",
    isActive: true,
    $or: [{ userType: "normal_user" }],
  };

  if (isPremiumActiveUser(user)) {
    filter.$or.push({ userType: "premium_user", assignedUser: user._id });
  }

  return filter;
};

const toProgramCard = (program) => ({
  id: program._id,
  name: program.programName,
  duration: program.programDuration,
  weekCount: program.weekCount || 0,
  level: program.programLevel,
  totalExercises: program.totalExercises || 0,
  image: program.programImages?.[0] || null,
  thumbnail: program.programThumbnails?.[0] || null,
});

const toRecipeCard = (recipe) => ({
  id: recipe._id,
  name: recipe.recipeName,
  type: recipe.recipeType,
  duration: recipe.recipeDuration,
  caloriesKcal: recipe.caloriesKcal,
  proteinG: recipe.proteinG,
  carbsG: recipe.carbsG,
  fatG: recipe.fatG,
  image: recipe.recipeImages?.[0] || null,
});

const formatTimeAgo = (date) => {
  const now = Date.now();
  const diffMs = Math.max(0, now - new Date(date).getTime());
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  return `${Math.floor(diffMs / day)}d ago`;
};

const toNotificationResponse = (notification) => ({
  id: notification._id,
  type: notification.type,
  title: notification.title,
  message: notification.message,
  read: Boolean(notification.readAt),
  readAt: notification.readAt || null,
  createdAt: notification.createdAt,
  timeAgo: formatTimeAgo(notification.createdAt),
});

const toSupportTicketResponse = (ticket) => ({
  id: ticket._id,
  email: ticket.email,
  subject: ticket.subject,
  description: ticket.description,
  status: ticket.status,
  adminResponse: ticket.adminResponse || "",
  resolvedAt: ticket.resolvedAt || null,
  createdAt: ticket.createdAt,
  updatedAt: ticket.updatedAt,
});

const toWorkoutExperienceResponse = (experience) => ({
  id: experience._id,
  program:
    experience.program && typeof experience.program === "object" && experience.program._id
      ? {
        id: experience.program._id,
        programName: experience.program.programName,
      }
      : experience.program || null,
  experienceLevel: experience.experienceLevel,
  notes: experience.notes || "",
  completedAt: experience.completedAt,
  createdAt: experience.createdAt,
  updatedAt: experience.updatedAt,
});

const getAccessibilityPreferencesResponse = (user) => ({
  largerText: Boolean(user.accessibilityPreferences?.largerText),
  highContrast: Boolean(user.accessibilityPreferences?.highContrast),
  reducedMotion: Boolean(user.accessibilityPreferences?.reducedMotion),
  screenReaderOptimized: Boolean(user.accessibilityPreferences?.screenReaderOptimized),
});

const ensureDefaultTracker = async (userId, weekStartDate) => {
  const weekNumber = getIsoWeekNumber(weekStartDate);

  let tracker = await DailyTracker.findOne({ user: userId, weekStartDate });
  if (!tracker) {
    tracker = await DailyTracker.create({
      user: userId,
      weekStartDate,
      weekNumber,
      habits: DEFAULT_TRACKER_HABITS.map((habit) => ({
        ...habit,
        days: [false, false, false, false, false, false, false],
      })),
      notes: [],
    });
  }

  return tracker;
};

const ensureDefaultNotifications = async (userId) => {
  const count = await Notification.countDocuments({ user: userId });
  if (count > 0) return;

  const now = new Date();
  const payload = DEFAULT_NOTIFICATION_ITEMS.map((item, index) => ({
    user: userId,
    title: item.title,
    message: item.message,
    type: item.type,
    createdAt: new Date(now.getTime() - index * 2 * 60 * 1000),
    updatedAt: new Date(now.getTime() - index * 2 * 60 * 1000),
  }));

  await Notification.insertMany(payload);
};

const calculateStreakFromLogs = (logs, offsetMinutes = 0, referenceDate = new Date()) => {
  if (!Array.isArray(logs) || logs.length === 0) return 0;

  const daysSet = new Set(logs.map((log) => dateToYmd(log.completedAt || log.createdAt, offsetMinutes)));
  const todayKey = dateToYmd(referenceDate, offsetMinutes);
  const yesterdayKey = dateToYmd(new Date(referenceDate.getTime() - DAY_MS), offsetMinutes);

  if (!daysSet.has(todayKey) && !daysSet.has(yesterdayKey)) {
    return 0;
  }

  let streak = 0;
  let pointer = daysSet.has(todayKey)
    ? getLocalStartOfDayUtc(referenceDate, offsetMinutes)
    : getLocalStartOfDayUtc(new Date(referenceDate.getTime() - DAY_MS), offsetMinutes);

  while (daysSet.has(dateToYmd(pointer, offsetMinutes))) {
    streak += 1;
    pointer = new Date(pointer.getTime() - DAY_MS);
  }

  return streak;
};

const calculateActiveWeeksFromLogs = (logs, offsetMinutes = 0) =>
  Array.isArray(logs) ? new Set(logs.map((log) => getLocalWeekKey(log.completedAt || log.createdAt, offsetMinutes))).size : 0;

const toKg = (measurement) => {
  if (!measurement || typeof measurement.value !== "number") return 0;
  if (measurement.unit === "kg") return measurement.value;
  if (measurement.unit === "lbs") return measurement.value * 0.453592;
  return 0;
};

const toMeters = (measurement) => {
  if (!measurement || typeof measurement.value !== "number") return 0;
  if (measurement.unit === "cm") return measurement.value / 100;
  if (measurement.unit === "ft") return measurement.value * 0.3048;
  return 0;
};

const roundNumber = (value, digits = 1) => Number(Number(value || 0).toFixed(digits));

const buildRecentWorkoutChartDays = (logs, offsetMinutes = 0, referenceDate = new Date()) => {
  const todayStartUtc = getLocalStartOfDayUtc(referenceDate, offsetMinutes);
  const dayMap = new Map();

  for (const log of logs) {
    const key = dateToYmd(log.completedAt || log.createdAt, offsetMinutes);
    const existing = dayMap.get(key) || { workouts: 0, calories: 0 };
    existing.workouts += 1;
    existing.calories += Number(log.caloriesBurned || 0);
    dayMap.set(key, existing);
  }

  const chartDays = [];
  for (let i = 6; i >= 0; i -= 1) {
    const dayStartUtc = new Date(todayStartUtc.getTime() - (i * DAY_MS));
    const key = dateToYmd(dayStartUtc, offsetMinutes);
    const aggregate = dayMap.get(key);

    chartDays.push({
      date: key,
      label: getWeekdayLabel(dayStartUtc, offsetMinutes),
      workouts: aggregate?.workouts || 0,
      calories: roundNumber(aggregate?.calories || 0, 2),
    });
  }

  return chartDays;
};

const buildWorkoutProgressStats = async (userId, offsetMinutes = 0) => {
  const now = new Date();
  const weeklyRangeStartUtc = new Date(getLocalStartOfDayUtc(now, offsetMinutes).getTime() - (6 * DAY_MS));

  const [totalWorkouts, allLogs, recentLogs] = await Promise.all([
    WorkoutLog.countDocuments({ user: userId }),
    WorkoutLog.find({ user: userId }).select("completedAt").lean(),
    WorkoutLog.find({ user: userId, completedAt: { $gte: weeklyRangeStartUtc } })
      .select("completedAt caloriesBurned")
      .lean(),
  ]);

  const streakDays = calculateStreakFromLogs(allLogs, offsetMinutes, now);
  const activityWeeks = calculateActiveWeeksFromLogs(allLogs, offsetMinutes);
  const chartDays = buildRecentWorkoutChartDays(recentLogs, offsetMinutes, now);
  const weeklyTotalCalories = roundNumber(chartDays.reduce((sum, item) => sum + item.calories, 0), 2);
  const weeklyTarget = Number(process.env.WEEKLY_CALORIE_TARGET || 2000);
  const caloriesPercent = weeklyTarget > 0 ? Math.min(100, Math.round((weeklyTotalCalories / weeklyTarget) * 100)) : 0;

  return {
    totalWorkouts,
    streakDays,
    activityWeeks,
    chartDays,
    weeklyTarget,
    weeklyTotalCalories,
    caloriesPercent,
  };
};

const getWeightChangeThisMonthKg = async (userId, currentWeightKg, offsetMinutes = 0) => {
  if (!currentWeightKg) {
    return 0;
  }

  const startOfMonthUtc = getLocalStartOfMonthUtc(new Date(), offsetMinutes);
  const [baselineBeforeMonth, firstThisMonth] = await Promise.all([
    WeightLog.findOne({ user: userId, recordedAt: { $lt: startOfMonthUtc } })
      .sort({ recordedAt: -1 })
      .select("weightKg")
      .lean(),
    WeightLog.findOne({ user: userId, recordedAt: { $gte: startOfMonthUtc } })
      .sort({ recordedAt: 1 })
      .select("weightKg")
      .lean(),
  ]);

  const baselineWeightKg = Number(baselineBeforeMonth?.weightKg ?? firstThisMonth?.weightKg);
  if (!Number.isFinite(baselineWeightKg)) {
    return 0;
  }

  return roundNumber(currentWeightKg - baselineWeightKg, 1);
};

const getGreetingLabel = (offsetMinutes = 0) => {
  const hour = shiftDateByOffset(new Date(), offsetMinutes).getUTCHours();
  if (hour < 12) return "Good morning!";
  if (hour < 17) return "Good afternoon!";
  return "Good evening!";
};

export const getHomeOverview = catchAsync(async (req, res) => {
  const recipeType = asString(req.query.recipeType).toLowerCase() || "breakfast";
  if (!RECIPE_TYPES.has(recipeType)) {
    throw new AppError("Invalid recipeType filter.", httpStatus.BAD_REQUEST);
  }

  const tzOffsetMinutes = getRequestTimezoneOffsetMinutes(req);
  const trackedProgramIds = await collectTrackedProgramIdsForUser(req.user._id);
  const myProgramsFilter = buildMyProgramsFilter(req.user, trackedProgramIds);

  const [workoutStats, programs, recipes] = await Promise.all([
    buildWorkoutProgressStats(req.user._id, tzOffsetMinutes),
    myProgramsFilter
      ? Program.find(myProgramsFilter)
          .sort({ createdAt: -1 })
          .limit(3)
          .select("programName programDuration weekCount programLevel totalExercises programImages programThumbnails")
      : Promise.resolve([]),
    Recipe.find({
      ...buildRecipeAccessFilter(req.user),
      ...(recipeType !== "all" ? { recipeType } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(6)
      .select("recipeName recipeType recipeDuration caloriesKcal proteinG carbsG fatG recipeImages"),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: {
      welcome: {
        firstName: req.user.firstName,
        greeting: getGreetingLabel(tzOffsetMinutes),
      },
      stats: {
        streakDays: workoutStats.streakDays,
        totalWorkouts: workoutStats.totalWorkouts,
        caloriesPercent: workoutStats.caloriesPercent,
        activityPeriodWeeks: workoutStats.activityWeeks,
        weeklyCaloriesBurnedKcal: workoutStats.weeklyTotalCalories,
        weeklyCalorieTargetKcal: workoutStats.weeklyTarget,
      },
      myPrograms: programs.map(toProgramCard),
      myRecipes: recipes.map(toRecipeCard),
      quickActions: [
        { key: "progress", label: "Progress" },
        { key: "daily_tracker", label: "Daily Tracker" },
      ],
    },
  });
});

export const getDailyTracker = catchAsync(async (req, res) => {
  const weekStartDate = getWeekStartDate(req.query.weekStartDate);
  const tracker = await ensureDefaultTracker(req.user._id, weekStartDate);

  res.status(httpStatus.OK).json({
    success: true,
    data: {
      id: tracker._id,
      weekStartDate: tracker.weekStartDate,
      weekNumber: tracker.weekNumber,
      completionRate: tracker.completionRate,
      habits: tracker.habits || [],
      notes: tracker.notes || [],
    },
  });
});

export const updateDailyTracker = catchAsync(async (req, res) => {
  const weekStartDate = getWeekStartDate(req.body.weekStartDate || req.query.weekStartDate);
  const tracker = await ensureDefaultTracker(req.user._id, weekStartDate);

  if (Array.isArray(req.body.habits)) {
    tracker.habits = req.body.habits.map((habit, index) => {
      const key = asString(habit.key || `habit_${index + 1}`);
      const title = asString(habit.title || key);
      const icon = asString(habit.icon || "");
      const days = Array.isArray(habit.days) ? habit.days.map((value) => Boolean(value)).slice(0, 7) : [];

      while (days.length < 7) {
        days.push(false);
      }

      return { key, title, icon, days };
    });
  }

  if (req.body.habitKey) {
    const habitKey = asString(req.body.habitKey);
    const dayIndex = parseNumber(req.body.dayIndex, "dayIndex", 1, true);
    if (dayIndex > 7) {
      throw new AppError("dayIndex must be between 1 and 7.", httpStatus.BAD_REQUEST);
    }

    const completed = parseBoolean(req.body.completed, "completed");
    const habitTitle = asString(req.body.habitTitle || habitKey);
    const habitIcon = asString(req.body.habitIcon || "");

    let habit = tracker.habits.find((item) => item.key === habitKey);
    if (!habit) {
      habit = {
        key: habitKey,
        title: habitTitle,
        icon: habitIcon,
        days: [false, false, false, false, false, false, false],
      };
      tracker.habits.push(habit);
    }

    while (habit.days.length < 7) {
      habit.days.push(false);
    }

    habit.days[dayIndex - 1] = completed;
  }

  await tracker.save();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Daily tracker updated successfully.",
    data: {
      id: tracker._id,
      weekStartDate: tracker.weekStartDate,
      weekNumber: tracker.weekNumber,
      completionRate: tracker.completionRate,
      habits: tracker.habits || [],
      notes: tracker.notes || [],
    },
  });
});

export const addDailyTrackerNote = catchAsync(async (req, res) => {
  const weekStartDate = getWeekStartDate(req.body.weekStartDate || req.query.weekStartDate);
  const tracker = await ensureDefaultTracker(req.user._id, weekStartDate);

  const text = asString(req.body.text || req.body.note);
  if (!text) {
    throw new AppError("Note text is required.", httpStatus.BAD_REQUEST);
  }

  if (text.length > 500) {
    throw new AppError("Note text should not exceed 500 characters.", httpStatus.BAD_REQUEST);
  }

  const dayIndex = req.body.dayIndex
    ? parseNumber(req.body.dayIndex, "dayIndex", 1, true)
    : getWeekdayIndexWithinWeek(weekStartDate, new Date());

  if (dayIndex < 1 || dayIndex > 7) {
    throw new AppError("dayIndex must be between 1 and 7.", httpStatus.BAD_REQUEST);
  }

  tracker.notes.push({
    text,
    dayIndex,
    createdAt: new Date(),
  });

  await tracker.save();

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Note added successfully.",
    data: {
      notes: tracker.notes || [],
      completionRate: tracker.completionRate,
    },
  });
});

export const getMyDailyTrackerNotes = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;
  const match = { user: req.user._id };

  if (req.query.weekStartDate) {
    match.weekStartDate = getWeekStartDate(req.query.weekStartDate);
  }

  const [notes, totalAgg] = await Promise.all([
    DailyTracker.aggregate([
      { $match: match },
      { $unwind: "$notes" },
      {
        $project: {
          _id: 0,
          trackerId: "$_id",
          weekStartDate: 1,
          weekNumber: 1,
          text: "$notes.text",
          dayIndex: "$notes.dayIndex",
          createdAt: "$notes.createdAt",
        },
      },
      { $sort: { createdAt: -1, trackerId: -1 } },
      { $skip: skip },
      { $limit: limit },
    ]),
    DailyTracker.aggregate([{ $match: match }, { $unwind: "$notes" }, { $count: "total" }]),
  ]);

  const total = totalAgg[0]?.total || 0;

  res.status(httpStatus.OK).json({
    success: true,
    data: notes.map((note) => ({
      trackerId: note.trackerId,
      weekStartDate: note.weekStartDate,
      weekNumber: note.weekNumber,
      dayIndex: note.dayIndex,
      text: note.text,
      createdAt: note.createdAt || null,
      date: note.createdAt ? dateToYmd(note.createdAt) : null,
    })),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  });
});

export const createWorkoutLog = catchAsync(async (req, res) => {
  const programId = parseObjectId(req.body.programId, "programId");
  const exerciseName = asString(req.body.exerciseName);
  const caloriesBurned = parseNumber(req.body.caloriesBurned, "caloriesBurned", 0, false) || 0;
  const durationMinutes = parseNumber(req.body.durationMinutes, "durationMinutes", 0, false) || 0;
  const notes = asString(req.body.notes);

  const sets = Array.isArray(req.body.sets)
    ? req.body.sets.map((set, index) => ({
      setNumber: parseNumber(set.setNumber ?? index + 1, "setNumber", 1, true),
      reps: parseNumber(set.reps, "reps", 0, false),
      weightKg: parseNumber(set.weightKg, "weightKg", 0, false),
      durationSeconds: parseNumber(set.durationSeconds, "durationSeconds", 0, false),
    }))
    : [];

  if (!programId && !exerciseName) {
    throw new AppError("Either programId or exerciseName is required.", httpStatus.BAD_REQUEST);
  }

  if (programId) {
    const program = await Program.findOne({
      _id: programId,
      ...buildProgramAccessFilter(req.user),
    });

    if (!program) {
      throw new AppError("Program not found or not accessible.", httpStatus.NOT_FOUND);
    }
  }

  const completedAt = req.body.completedAt ? parseDate(req.body.completedAt, "completedAt") : new Date();

  const workoutLog = await WorkoutLog.create({
    user: req.user._id,
    program: programId || null,
    exerciseName,
    sets,
    caloriesBurned,
    durationMinutes,
    notes,
    completedAt,
  });

  if (programId) {
    await touchUserProgram({
      userId: req.user._id,
      programId,
      touchedAt: completedAt,
    });
  }

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Workout logged successfully.",
    data: {
      id: workoutLog._id,
      program: workoutLog.program,
      exerciseName: workoutLog.exerciseName,
      sets: workoutLog.sets,
      caloriesBurned: workoutLog.caloriesBurned,
      durationMinutes: workoutLog.durationMinutes,
      completedAt: workoutLog.completedAt,
      notes: workoutLog.notes,
      createdAt: workoutLog.createdAt,
    },
  });
});

export const getWorkoutLogs = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = { user: req.user._id };

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.exerciseName = pattern;
  }

  const [logs, total] = await Promise.all([
    WorkoutLog.find(filter).sort({ completedAt: -1 }).skip(skip).limit(limit),
    WorkoutLog.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: logs.map((log) => ({
      id: log._id,
      program: log.program,
      exerciseName: log.exerciseName,
      sets: log.sets,
      caloriesBurned: log.caloriesBurned,
      durationMinutes: log.durationMinutes,
      completedAt: log.completedAt,
      notes: log.notes,
      createdAt: log.createdAt,
    })),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  });
});

export const getMyExerciseSettings = catchAsync(async (req, res) => {
  const exerciseId = parseObjectId(req.params.exerciseId, "exerciseId");
  if (!exerciseId) {
    throw new AppError("exerciseId is required.", httpStatus.BAD_REQUEST);
  }

  const exercise = await ensureExerciseAccessibleForUser(exerciseId, req.user);
  const setting = await UserExerciseSetting.findOne({ user: req.user._id, exercise: exercise._id }).select("customSets");

  res.status(httpStatus.OK).json({
    success: true,
    data: toExerciseSettingsResponse(exercise, setting?.customSets || []),
  });
});

export const upsertMyExerciseSettings = catchAsync(async (req, res) => {
  const exerciseId = parseObjectId(req.params.exerciseId, "exerciseId");
  if (!exerciseId) {
    throw new AppError("exerciseId is required.", httpStatus.BAD_REQUEST);
  }

  const exercise = await ensureExerciseAccessibleForUser(exerciseId, req.user);
  const shouldReset = Object.hasOwn(req.body || {}, "reset") && parseBoolean(req.body.reset, "reset");

  if (shouldReset) {
    await UserExerciseSetting.deleteOne({ user: req.user._id, exercise: exercise._id });
    return res.status(httpStatus.OK).json({
      success: true,
      message: "Exercise settings reset to admin defaults.",
      data: toExerciseSettingsResponse(exercise, []),
    });
  }

  const customSets = parseCustomSetsFromBody(req.body || {});
  const exerciseDefaultSets = normalizeSetTemplatesForResponse(exercise.defaultSets);
  const exerciseExecutionMode = resolveExecutionMode(exercise.executionMode, exerciseDefaultSets);
  validateSetsMatchExecutionMode(customSets, exerciseExecutionMode, "customSets");

  if (customSets.length === 0) {
    await UserExerciseSetting.deleteOne({ user: req.user._id, exercise: exercise._id });
    return res.status(httpStatus.OK).json({
      success: true,
      message: "Exercise settings reset to admin defaults.",
      data: toExerciseSettingsResponse(exercise, []),
    });
  }

  const setting = await UserExerciseSetting.findOneAndUpdate(
    { user: req.user._id, exercise: exercise._id },
    {
      $set: {
        customSets,
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );

  res.status(httpStatus.OK).json({
    success: true,
    message: "Exercise settings saved successfully.",
    data: {
      ...toExerciseSettingsResponse(exercise, setting.customSets),
      updatedAt: setting.updatedAt,
    },
  });
});

export const resetMyExerciseSettings = catchAsync(async (req, res) => {
  const exerciseId = parseObjectId(req.params.exerciseId, "exerciseId");
  if (!exerciseId) {
    throw new AppError("exerciseId is required.", httpStatus.BAD_REQUEST);
  }

  const exercise = await ensureExerciseAccessibleForUser(exerciseId, req.user);
  await UserExerciseSetting.deleteOne({ user: req.user._id, exercise: exercise._id });

  res.status(httpStatus.OK).json({
    success: true,
    message: "Exercise settings reset to admin defaults.",
    data: toExerciseSettingsResponse(exercise, []),
  });
});

export const createWorkoutExperience = catchAsync(async (req, res) => {
  const programId = parseObjectId(req.body.programId, "programId");
  if (!programId) {
    throw new AppError("programId is required.", httpStatus.BAD_REQUEST);
  }

  const program = await Program.findOne({
    _id: programId,
    ...buildProgramAccessFilter(req.user),
  }).select("_id programName");

  if (!program) {
    throw new AppError("Program not found or not accessible.", httpStatus.NOT_FOUND);
  }

  const experienceLevel = normalizeWorkoutExperienceLevel(req.body.experienceLevel || req.body.difficulty);
  const notes = asString(req.body.notes || req.body.note);
  if (notes.length > 500) {
    throw new AppError("notes should not exceed 500 characters.", httpStatus.BAD_REQUEST);
  }

  const completedAt = req.body.completedAt ? parseDate(req.body.completedAt, "completedAt") : new Date();

  const workoutExperience = await WorkoutExperience.create({
    user: req.user._id,
    program: program._id,
    experienceLevel,
    notes,
    completedAt,
  });

  await touchUserProgram({
    userId: req.user._id,
    programId: program._id,
    touchedAt: completedAt,
  });

  const populated = await WorkoutExperience.findById(workoutExperience._id).populate("program", "programName");

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Workout experience submitted successfully.",
    data: toWorkoutExperienceResponse(populated),
  });
});

export const getMyWorkoutExperiences = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = { user: req.user._id };

  if (req.query.experienceLevel || req.query.difficulty) {
    filter.experienceLevel = normalizeWorkoutExperienceLevel(req.query.experienceLevel || req.query.difficulty);
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
      .populate("program", "programName"),
    WorkoutExperience.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: experiences.map(toWorkoutExperienceResponse),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  });
});

export const getProgressOverview = catchAsync(async (req, res) => {
  const tzOffsetMinutes = getRequestTimezoneOffsetMinutes(req);
  const workoutStats = await buildWorkoutProgressStats(req.user._id, tzOffsetMinutes);

  const weightKg = toKg(req.user.weightCurrent);
  const goalWeightKg = toKg(req.user.goalWeight);
  const heightM = toMeters(req.user.height);
  const weightChangeThisMonthKg = await getWeightChangeThisMonthKg(req.user._id, weightKg, tzOffsetMinutes);
  const bmi = heightM > 0 ? Number((weightKg / (heightM * heightM)).toFixed(1)) : null;
  let bmiStatus = "Unknown";
  if (bmi !== null) {
    if (bmi < 18.5) bmiStatus = "Underweight";
    else if (bmi < 25) bmiStatus = "Normal Range";
    else if (bmi < 30) bmiStatus = "Overweight";
    else bmiStatus = "Obese";
  }

  const weightDeltaToGoalKg = goalWeightKg > 0 ? Number((weightKg - goalWeightKg).toFixed(1)) : null;

  res.status(httpStatus.OK).json({
    success: true,
    data: {
      stats: {
        streakDays: workoutStats.streakDays,
        totalWorkouts: workoutStats.totalWorkouts,
        caloriesPercent: workoutStats.caloriesPercent,
        activityPeriodWeeks: workoutStats.activityWeeks,
        weeklyCaloriesBurnedKcal: workoutStats.weeklyTotalCalories,
        weeklyCalorieTargetKcal: workoutStats.weeklyTarget,
      },
      charts: {
        weeklyProgress: workoutStats.chartDays.map((item) => ({ label: item.label, value: item.workouts })),
        weeklyCalories: workoutStats.chartDays.map((item) => ({ label: item.label, value: item.calories })),
      },
      bodyMetrics: {
        weightKg: weightKg || null,
        goalWeightKg: goalWeightKg || null,
        weightDeltaToGoalKg,
        weightChangeThisMonthKg,
        bmi,
        bmiStatus,
        activityLevel: req.user.fitnessExperience || null,
      },
    },
  });
});

export const getNotificationList = catchAsync(async (req, res) => {
  await ensureDefaultNotifications(req.user._id);

  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = { user: req.user._id };
  if (asString(req.query.unreadOnly).toLowerCase() === "true") {
    filter.readAt = null;
  }

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ user: req.user._id, readAt: null }),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: notifications.map(toNotificationResponse),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      unreadCount,
    },
  });
});

export const markNotificationRead = catchAsync(async (req, res) => {
  const notificationId = parseObjectId(req.params.notificationId, "notificationId");
  if (!notificationId) {
    throw new AppError("notificationId is required.", httpStatus.BAD_REQUEST);
  }

  const notification = await Notification.findOne({ _id: notificationId, user: req.user._id });
  if (!notification) {
    throw new AppError("Notification not found.", httpStatus.NOT_FOUND);
  }

  notification.readAt = notification.readAt || new Date();
  await notification.save({ validateBeforeSave: false });

  res.status(httpStatus.OK).json({
    success: true,
    message: "Notification marked as read.",
    data: toNotificationResponse(notification),
  });
});

export const markAllNotificationsRead = catchAsync(async (req, res) => {
  const now = new Date();
  await Notification.updateMany({ user: req.user._id, readAt: null }, { $set: { readAt: now } });

  res.status(httpStatus.OK).json({
    success: true,
    message: "All notifications marked as read.",
  });
});

export const getLanguagePreference = catchAsync(async (req, res) => {
  res.status(httpStatus.OK).json({
    success: true,
    data: {
      preferredLanguage: req.user.preferredLanguage || "en",
      options: [
        { code: "en", label: "English" },
        { code: "sr", label: "Serbian" },
      ],
    },
  });
});

export const updateLanguagePreference = catchAsync(async (req, res) => {
  const languageCode = asString(req.body.preferredLanguage || req.body.language).toLowerCase();

  if (!LANGUAGE_CODES.has(languageCode)) {
    throw new AppError("preferredLanguage must be one of: en, sr.", httpStatus.BAD_REQUEST);
  }

  req.user.preferredLanguage = languageCode;
  await req.user.save({ validateBeforeSave: false });

  res.status(httpStatus.OK).json({
    success: true,
    message: "Language preference updated successfully.",
    data: {
      preferredLanguage: req.user.preferredLanguage,
    },
  });
});

export const getAccessibilityPreferences = catchAsync(async (req, res) => {
  res.status(httpStatus.OK).json({
    success: true,
    data: {
      accessibilityPreferences: getAccessibilityPreferencesResponse(req.user),
      options: [
        { key: "largerText", label: "Larger text" },
        { key: "highContrast", label: "High contrast" },
        { key: "reducedMotion", label: "Reduced motion" },
        { key: "screenReaderOptimized", label: "Screen reader optimized" },
      ],
    },
  });
});

export const updateAccessibilityPreferences = catchAsync(async (req, res) => {
  const input =
    req.body.accessibilityPreferences && typeof req.body.accessibilityPreferences === "object"
      ? req.body.accessibilityPreferences
      : req.body;

  const currentPreferences = getAccessibilityPreferencesResponse(req.user);
  const nextPreferences = { ...currentPreferences };

  for (const key of ACCESSIBILITY_KEYS) {
    if (Object.hasOwn(input, key)) {
      nextPreferences[key] = parseBoolean(input[key], key);
    }
  }

  req.user.accessibilityPreferences = nextPreferences;
  await req.user.save({ validateBeforeSave: false });

  res.status(httpStatus.OK).json({
    success: true,
    message: "Accessibility preferences updated successfully.",
    data: {
      accessibilityPreferences: getAccessibilityPreferencesResponse(req.user),
    },
  });
});

export const createSupportTicket = catchAsync(async (req, res) => {
  const bodyEmail = asString(req.body.email || req.body.userEmail).toLowerCase();
  const email = bodyEmail || asString(req.user?.email).toLowerCase();
  const subject = asString(req.body.subject);
  const description = asString(req.body.description);

  if (!email) {
    throw new AppError("Authenticated user email is required.", httpStatus.BAD_REQUEST);
  }

  if (!isValidEmail(email)) {
    throw new AppError("A valid email is required.", httpStatus.BAD_REQUEST);
  }

  if (!subject || !description) {
    throw new AppError("subject and description are required.", httpStatus.BAD_REQUEST);
  }

  if (description.length > 300) {
    throw new AppError("description should not exceed 300 characters.", httpStatus.BAD_REQUEST);
  }

  const ticket = await SupportTicket.create({
    user: req.user._id,
    email,
    subject,
    description,
  });

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Support request submitted successfully.",
    data: toSupportTicketResponse(ticket),
  });
});

export const getMySupportTickets = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = { user: req.user._id };
  if (req.query.status) {
    filter.status = asString(req.query.status).toLowerCase();
  }

  const [tickets, total] = await Promise.all([
    SupportTicket.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    SupportTicket.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: tickets.map(toSupportTicketResponse),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  });
});

export const changeMyPassword = catchAsync(async (req, res) => {
  const { currentPassword, newPassword, confirmNewPassword } = req.body;

  if (!currentPassword || !newPassword || !confirmNewPassword) {
    throw new AppError("currentPassword, newPassword and confirmNewPassword are required.", httpStatus.BAD_REQUEST);
  }

  if (newPassword !== confirmNewPassword) {
    throw new AppError("newPassword and confirmNewPassword do not match.", httpStatus.BAD_REQUEST);
  }

  const user = await User.findById(req.user._id).select("+password +refreshTokenHash +refreshTokenExpiresAt");
  if (!user) {
    throw new AppError("User not found.", httpStatus.NOT_FOUND);
  }

  const isValid = await user.comparePassword(currentPassword);
  if (!isValid) {
    throw new AppError("Current password is incorrect.", httpStatus.UNAUTHORIZED);
  }

  user.password = newPassword;
  user.clearRefreshToken();
  await user.save();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Password changed successfully. Please log in again.",
  });
});

export const getMyPublicProfile = catchAsync(async (req, res) => {
  res.status(httpStatus.OK).json({
    success: true,
    data: serializeUser(req.user),
  });
});

