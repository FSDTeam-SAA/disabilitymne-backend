import mongoose from "mongoose";
import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { isPremiumActiveUser } from "../utils/access.js";
import { serializeUser } from "../utils/serializeUser.js";
import { User } from "../models/user.model.js";
import { Program } from "../models/program.model.js";
import { Recipe } from "../models/recipe.model.js";
import { DailyTracker } from "../models/dailyTracker.model.js";
import { WorkoutLog } from "../models/workoutLog.model.js";
import { Notification } from "../models/notification.model.js";
import { SupportTicket } from "../models/supportTicket.model.js";

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

const parseObjectId = (value, fieldName) => {
  const id = asString(value);
  if (!id) return null;

  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(`${fieldName} must be a valid id.`, httpStatus.BAD_REQUEST);
  }

  return id;
};

const dateToYmd = (date) => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

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

const calculateStreakFromLogs = (logs) => {
  if (!Array.isArray(logs) || logs.length === 0) return 0;

  const daysSet = new Set(logs.map((log) => dateToYmd(log.completedAt || log.createdAt)));

  let streak = 0;
  const pointer = new Date();
  pointer.setHours(0, 0, 0, 0);

  while (daysSet.has(dateToYmd(pointer))) {
    streak += 1;
    pointer.setDate(pointer.getDate() - 1);
  }

  return streak;
};

const calculateActivityWeeks = (firstWorkoutAt) => {
  if (!firstWorkoutAt) return 0;
  const diff = Date.now() - new Date(firstWorkoutAt).getTime();
  const weeks = Math.ceil(diff / (7 * 24 * 60 * 60 * 1000));
  return Math.max(1, weeks);
};

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

const getGreetingLabel = () => {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning!";
  if (hour < 17) return "Good afternoon!";
  return "Good evening!";
};

export const getHomeOverview = catchAsync(async (req, res) => {
  const recipeType = asString(req.query.recipeType).toLowerCase() || "breakfast";
  if (!RECIPE_TYPES.has(recipeType)) {
    throw new AppError("Invalid recipeType filter.", httpStatus.BAD_REQUEST);
  }

  const [totalWorkouts, firstWorkout, recentWorkoutLogs, caloriesLastWeekAgg, programs, recipes] = await Promise.all([
    WorkoutLog.countDocuments({ user: req.user._id }),
    WorkoutLog.findOne({ user: req.user._id }).sort({ completedAt: 1 }).select("completedAt"),
    WorkoutLog.find({ user: req.user._id }).sort({ completedAt: -1 }).limit(365).select("completedAt"),
    WorkoutLog.aggregate([
      {
        $match: {
          user: req.user._id,
          completedAt: { $gte: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000) },
        },
      },
      { $group: { _id: null, totalCalories: { $sum: "$caloriesBurned" } } },
    ]),
    Program.find(buildProgramAccessFilter(req.user))
      .sort({ createdAt: -1 })
      .limit(3)
      .select("programName programDuration weekCount programLevel totalExercises programImages programThumbnails"),
    Recipe.find({
      ...buildRecipeAccessFilter(req.user),
      ...(recipeType !== "all" ? { recipeType } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(6)
      .select("recipeName recipeType recipeDuration caloriesKcal proteinG carbsG fatG recipeImages"),
  ]);

  const streakDays = calculateStreakFromLogs(recentWorkoutLogs);
  const weeklyCalories = caloriesLastWeekAgg[0]?.totalCalories || 0;
  const weeklyTarget = Number(process.env.WEEKLY_CALORIE_TARGET || 2000);
  const caloriesPercent = weeklyTarget > 0 ? Math.min(100, Math.round((weeklyCalories / weeklyTarget) * 100)) : 0;
  const activityWeeks = calculateActivityWeeks(firstWorkout?.completedAt);

  res.status(httpStatus.OK).json({
    success: true,
    data: {
      welcome: {
        firstName: req.user.firstName,
        greeting: getGreetingLabel(),
      },
      stats: {
        streakDays,
        totalWorkouts,
        caloriesPercent,
        activityPeriodWeeks: activityWeeks,
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

export const getProgressOverview = catchAsync(async (req, res) => {
  const totalWorkouts = await WorkoutLog.countDocuments({ user: req.user._id });

  const [recentLogs, firstWorkout, last7DaysAgg] = await Promise.all([
    WorkoutLog.find({ user: req.user._id }).sort({ completedAt: -1 }).limit(365).select("completedAt"),
    WorkoutLog.findOne({ user: req.user._id }).sort({ completedAt: 1 }).select("completedAt"),
    WorkoutLog.aggregate([
      {
        $match: {
          user: req.user._id,
          completedAt: { $gte: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000) },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$completedAt" },
            month: { $month: "$completedAt" },
            day: { $dayOfMonth: "$completedAt" },
          },
          calories: { $sum: "$caloriesBurned" },
          workouts: { $sum: 1 },
        },
      },
    ]),
  ]);

  const streakDays = calculateStreakFromLogs(recentLogs);
  const activityWeeks = calculateActivityWeeks(firstWorkout?.completedAt);
  const weeklyTotalCalories = last7DaysAgg.reduce((sum, item) => sum + item.calories, 0);
  const weeklyTarget = Number(process.env.WEEKLY_CALORIE_TARGET || 2000);
  const caloriesPercent = weeklyTarget > 0 ? Math.min(100, Math.round((weeklyTotalCalories / weeklyTarget) * 100)) : 0;

  const dayMap = new Map(
    last7DaysAgg.map((item) => [
      `${item._id.year}-${String(item._id.month).padStart(2, "0")}-${String(item._id.day).padStart(2, "0")}`,
      item,
    ])
  );

  const chartDays = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = dateToYmd(d);
    const aggregate = dayMap.get(key);

    chartDays.push({
      date: key,
      label: d.toLocaleString("en-US", { weekday: "short" }),
      workouts: aggregate?.workouts || 0,
      calories: Number((aggregate?.calories || 0).toFixed(2)),
    });
  }

  const weightKg = toKg(req.user.weightCurrent);
  const goalWeightKg = toKg(req.user.goalWeight);
  const heightM = toMeters(req.user.height);
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
        streakDays,
        totalWorkouts,
        caloriesPercent,
        activityPeriodWeeks: activityWeeks,
      },
      charts: {
        weeklyProgress: chartDays.map((item) => ({ label: item.label, value: item.workouts })),
        weeklyCalories: chartDays.map((item) => ({ label: item.label, value: item.calories })),
      },
      bodyMetrics: {
        weightKg: weightKg || null,
        goalWeightKg: goalWeightKg || null,
        weightDeltaToGoalKg,
        weightChangeThisMonthKg: 0,
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
  const email = asString(req.user?.email).toLowerCase();
  const subject = asString(req.body.subject);
  const description = asString(req.body.description);

  if (!email) {
    throw new AppError("Authenticated user email is required.", httpStatus.BAD_REQUEST);
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

