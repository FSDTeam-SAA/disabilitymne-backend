import mongoose from "mongoose";
import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { isPremiumActiveUser } from "../utils/access.js";
import { Program } from "../models/program.model.js";
import { User } from "../models/user.model.js";

const PROGRAM_LEVELS = new Set(["beginner", "intermediate", "advanced"]);
const PROGRAM_USER_TYPES = new Set(["normal_user", "premium_user"]);
const PROGRAM_STATUSES = new Set(["draft", "published", "archived"]);

const parseMaybeJson = (value) => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  } 

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

const getField = (body, keys) => {
  for (const key of keys) {
    if (Object.hasOwn(body, key)) {
      return { provided: true, value: body[key] };
    }
  }

  return { provided: false, value: undefined };
};

const asNonEmptyString = (value) => {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
};

const escapeRegex = (input) => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeProgramLevel = (value) => {
  const normalized = asNonEmptyString(value).toLowerCase().replace(/\s+/g, "_");

  if (!PROGRAM_LEVELS.has(normalized)) {
    throw new AppError("programLevel must be one of: beginner, intermediate, advanced.", httpStatus.BAD_REQUEST);
  }

  return normalized;
};

const normalizeUserType = (value) => {
  const cleaned = asNonEmptyString(value).toLowerCase().replace(/\s+/g, "_");
  if (!cleaned || cleaned === "normal") return "normal_user";
  if (cleaned === "premium") return "premium_user";

  if (!PROGRAM_USER_TYPES.has(cleaned)) {
    throw new AppError("userType must be either normal_user or premium_user.", httpStatus.BAD_REQUEST);
  }

  return cleaned;
};

const normalizeProgramStatus = (value) => {
  const normalized = asNonEmptyString(value).toLowerCase();
  if (!PROGRAM_STATUSES.has(normalized)) {
    throw new AppError("status must be one of: draft, published, archived.", httpStatus.BAD_REQUEST);
  }

  return normalized;
};

const numberOrUndefined = (value, fieldName, min = 0) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    throw new AppError(`${fieldName} must be a number >= ${min}.`, httpStatus.BAD_REQUEST);
  }

  return n;
};

const parseDurationMinutes = (value, durationLabel) => {
  const direct = numberOrUndefined(value, "durationMinutes", 1);
  if (direct !== undefined) {
    return Math.round(direct);
  }

  const label = asNonEmptyString(durationLabel);
  if (label) {
    const matched = label.match(/\d+/);
    if (matched) {
      return Math.max(1, Number(matched[0]));
    }
  }

  throw new AppError(
    "durationMinutes is required (or provide a parseable number in programDuration).",
    httpStatus.BAD_REQUEST
  );
};

const extractDurationMinutesFromLabel = (durationLabel) => {
  const label = asNonEmptyString(durationLabel);
  if (!label) {
    return undefined;
  }

  const matched = label.match(/\d+/);
  if (!matched) {
    return undefined;
  }

  const value = Number(matched[0]);
  if (!Number.isFinite(value) || value < 1) {
    return undefined;
  }

  return Math.round(value);
};

const normalizeMediaAsset = (rawValue) => {
  const value = parseMaybeJson(rawValue);

  if (!value) return null;

  if (typeof value === "string") {
    const url = value.trim();
    if (!url) return null;

    return {
      url,
      publicId: "",
      mimetype: "",
      size: 0,
    };
  }

  if (typeof value !== "object") {
    return null;
  }

  const url = asNonEmptyString(value.url || value.path || value.secure_url);
  if (!url) {
    return null;
  }

  const size = Number(value.size);

  return {
    url,
    publicId: asNonEmptyString(value.publicId || value.public_id || value.filename),
    mimetype: asNonEmptyString(value.mimetype || value.resource_type || value.format),
    size: Number.isFinite(size) && size > 0 ? size : 0,
  };
};

const normalizeMediaList = (rawValue) => {
  const value = parseMaybeJson(rawValue);

  if (value === undefined || value === null || value === "") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map(normalizeMediaAsset).filter(Boolean);
  }

  const single = normalizeMediaAsset(value);
  return single ? [single] : [];
};

const normalizeDefaultSets = (rawValue) => {
  const value = parseMaybeJson(rawValue);

  if (!value || !Array.isArray(value)) {
    return [];
  }

  return value
    .map((set, index) => {
      if (!set || typeof set !== "object") {
        return null;
      }

      const setNumber = numberOrUndefined(set.setNumber ?? index + 1, "setNumber", 1);
      const reps = numberOrUndefined(set.reps, "reps", 0);
      const weightKg = numberOrUndefined(set.weightKg, "weightKg", 0);
      const durationSeconds = numberOrUndefined(set.durationSeconds, "durationSeconds", 0);

      const normalizedSet = { setNumber };
      if (reps !== undefined) normalizedSet.reps = reps;
      if (weightKg !== undefined) normalizedSet.weightKg = weightKg;
      if (durationSeconds !== undefined) normalizedSet.durationSeconds = durationSeconds;
      return normalizedSet;
    })
    .filter(Boolean);
};

const normalizeExercise = (rawExercise, index) => {
  const parsed = parseMaybeJson(rawExercise);

  if (typeof parsed === "string") {
    const name = parsed.trim();
    if (!name) return null;

    return {
      name,
      order: index + 1,
      description: "",
      defaultSets: [],
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const name = asNonEmptyString(parsed.name || parsed.exerciseName || parsed.title);
  if (!name) {
    throw new AppError(`Exercise at index ${index + 1} is missing a name.`, httpStatus.BAD_REQUEST);
  }

  const order = numberOrUndefined(parsed.order, "exercise.order", 1) ?? index + 1;
  const description = asNonEmptyString(parsed.description || parsed.exerciseDescription);
  const demoVideo = normalizeMediaAsset(parsed.demoVideo || parsed.video || parsed.demo);
  const image = normalizeMediaAsset(parsed.image || parsed.thumbnail || parsed.exerciseImage);
  const defaultSets = normalizeDefaultSets(parsed.defaultSets || parsed.sets);
  const durationSeconds = numberOrUndefined(parsed.durationSeconds, "exercise.durationSeconds", 0);
  const calories = numberOrUndefined(parsed.calories, "exercise.calories", 0);

  const normalizedExercise = {
    name,
    description,
    order,
    defaultSets,
  };

  if (demoVideo) normalizedExercise.demoVideo = demoVideo;
  if (image) normalizedExercise.image = image;
  if (durationSeconds !== undefined) normalizedExercise.durationSeconds = durationSeconds;
  if (calories !== undefined) normalizedExercise.calories = calories;

  return normalizedExercise;
};

const normalizeExercises = (rawValue) => {
  const parsed = parseMaybeJson(rawValue);

  if (!parsed) {
    return [];
  }

  if (typeof parsed === "string") {
    const items = parsed
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    return items.map((name, index) => ({ name, order: index + 1, description: "", defaultSets: [] }));
  }

  if (!Array.isArray(parsed)) {
    throw new AppError("exercises must be an array (or JSON array string).", httpStatus.BAD_REQUEST);
  }

  return parsed.map((exercise, index) => normalizeExercise(exercise, index)).filter(Boolean);
};

const parseBoolean = (value, fieldName) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

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
  const id = asNonEmptyString(value);
  if (!id) return null;

  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(`${fieldName} must be a valid id.`, httpStatus.BAD_REQUEST);
  }

  return id;
};

const ensurePremiumUserAssignable = async (userId) => {
  const parsedId = parseObjectId(userId, "assignedUser");
  if (!parsedId) {
    throw new AppError("assignedUser is required for premium_user programs.", httpStatus.BAD_REQUEST);
  }

  const user = await User.findById(parsedId).select("firstName email role selectedPlan subscriptionStatus isActive");

  if (!user || !user.isActive) {
    throw new AppError("Assigned user was not found.", httpStatus.NOT_FOUND);
  }

  if (user.role === "admin") {
    throw new AppError("Assigned user must be a regular user account.", httpStatus.BAD_REQUEST);
  }

  if (user.selectedPlan !== "premium_plan" || user.subscriptionStatus !== "active") {
    throw new AppError(
      "Assigned user must have an active premium subscription before receiving private programs.",
      httpStatus.BAD_REQUEST
    );
  }

  return user;
};

const buildProgramSummary = (program) => {
  const assignedUser = program.assignedUser && typeof program.assignedUser === "object" && program.assignedUser._id
    ? {
        id: program.assignedUser._id,
        firstName: program.assignedUser.firstName,
        email: program.assignedUser.email,
      }
    : program.assignedUser || null;

  return {
    id: program._id,
    programName: program.programName,
    programDuration: program.programDuration,
    durationMinutes: program.durationMinutes,
    programLevel: program.programLevel,
    userType: program.userType,
    assignedUser,
    programDescription: program.programDescription,
    safetyNote: program.safetyNote,
    mobilityType: program.mobilityType,
    weekCount: program.weekCount,
    totalExercises: program.totalExercises,
    status: program.status,
    isActive: program.isActive,
    programImage: program.programImages?.[0] || null,
    programThumbnail: program.programThumbnails?.[0] || null,
    programImages: program.programImages || [],
    programThumbnails: program.programThumbnails || [],
    createdAt: program.createdAt,
    updatedAt: program.updatedAt,
  };
};

const buildProgramDetails = (program) => ({
  ...buildProgramSummary(program),
  exercises: (program.exercises || []).map((exercise) => ({
    name: exercise.name,
    description: exercise.description,
    order: exercise.order,
    demoVideo: exercise.demoVideo || null,
    image: exercise.image || null,
    defaultSets: exercise.defaultSets || [],
    durationSeconds: exercise.durationSeconds ?? null,
    calories: exercise.calories ?? null,
  })),
});

const buildPagination = (page, limit, total) => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});

const parsePage = (value) => {
  const page = Number(value || 1);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
};

const parseLimit = (value, defaultValue = 10, maxValue = 100) => {
  const limit = Number(value || defaultValue);
  if (!Number.isFinite(limit) || limit <= 0) return defaultValue;
  return Math.min(Math.floor(limit), maxValue);
};

const buildCreatePayload = async (body) => {
  const parsedBody = body || {};

  const programName = asNonEmptyString(getField(parsedBody, ["programName", "name"]).value);
  if (!programName) {
    throw new AppError("programName is required.", httpStatus.BAD_REQUEST);
  }

  const userType = normalizeUserType(getField(parsedBody, ["userType"]).value || "normal_user");
  const programLevel = normalizeProgramLevel(getField(parsedBody, ["programLevel", "level"]).value || "beginner");

  const rawDurationLabel = getField(parsedBody, ["programDuration", "duration"]).value;
  let programDuration = asNonEmptyString(rawDurationLabel);
  const durationMinutes = parseDurationMinutes(
    getField(parsedBody, ["durationMinutes"]).value,
    programDuration
  );
  if (!programDuration) {
    programDuration = `${durationMinutes} Minute`;
  }

  const exercises = normalizeExercises(getField(parsedBody, ["exercises", "exerciseList"]).value);
  if (exercises.length === 0) {
    throw new AppError("At least one exercise is required.", httpStatus.BAD_REQUEST);
  }

  const programImages = normalizeMediaList(getField(parsedBody, ["programImages", "programImage", "coverImage"]).value);
  if (programImages.length === 0) {
    throw new AppError("At least one program image is required.", httpStatus.BAD_REQUEST);
  }

  const programThumbnails = normalizeMediaList(
    getField(parsedBody, ["programThumbnails", "programThumbnail", "thumbnailImage"]).value
  );

  const programDescription = asNonEmptyString(
    getField(parsedBody, ["programDescription", "description"]).value
  );
  const safetyNote = asNonEmptyString(getField(parsedBody, ["safetyNote"]).value);
  const mobilityType = asNonEmptyString(getField(parsedBody, ["mobilityType", "programMobility"]).value);
  const weekCount = numberOrUndefined(getField(parsedBody, ["weekCount"]).value, "weekCount", 1) ?? 12;
  const status = normalizeProgramStatus(getField(parsedBody, ["status"]).value || "published");

  let assignedUser = null;
  if (userType === "premium_user") {
    const assignedInput = getField(parsedBody, ["assignedUser", "assignedUserId", "targetUserId", "userId"]).value;
    const premiumUser = await ensurePremiumUserAssignable(assignedInput);
    assignedUser = premiumUser._id;
  }

  return {
    programName,
    programDuration,
    durationMinutes,
    programLevel,
    userType,
    assignedUser,
    programDescription,
    safetyNote,
    mobilityType,
    weekCount,
    programImages,
    programThumbnails,
    exercises,
    totalExercises: exercises.length,
    status,
    isActive: status !== "archived",
  };
};

const buildUpdatePayload = async (body, currentProgram) => {
  const parsedBody = body || {};
  const updates = {};

  const nameInput = getField(parsedBody, ["programName", "name"]);
  if (nameInput.provided) {
    const programName = asNonEmptyString(nameInput.value);
    if (!programName) {
      throw new AppError("programName cannot be empty.", httpStatus.BAD_REQUEST);
    }
    updates.programName = programName;
  }

  const durationLabelInput = getField(parsedBody, ["programDuration", "duration"]);
  const durationMinutesInput = getField(parsedBody, ["durationMinutes"]);
  if (durationLabelInput.provided) {
    const label = asNonEmptyString(durationLabelInput.value);
    if (!label) {
      throw new AppError("programDuration cannot be empty.", httpStatus.BAD_REQUEST);
    }
    updates.programDuration = label;
    if (!durationMinutesInput.provided) {
      updates.durationMinutes = extractDurationMinutesFromLabel(label) ?? currentProgram.durationMinutes;
    }
  }

  if (durationMinutesInput.provided) {
    const minutes = parseDurationMinutes(durationMinutesInput.value, updates.programDuration || currentProgram.programDuration);
    updates.durationMinutes = minutes;
    if (!durationLabelInput.provided) {
      updates.programDuration = `${minutes} Minute`;
    }
  }

  const levelInput = getField(parsedBody, ["programLevel", "level"]);
  if (levelInput.provided) {
    updates.programLevel = normalizeProgramLevel(levelInput.value);
  }

  const userTypeInput = getField(parsedBody, ["userType"]);
  const assignedUserInput = getField(parsedBody, ["assignedUser", "assignedUserId", "targetUserId", "userId"]);
  if (userTypeInput.provided || assignedUserInput.provided) {
    const nextUserType = userTypeInput.provided ? normalizeUserType(userTypeInput.value) : currentProgram.userType;
    let nextAssignedUser = assignedUserInput.provided
      ? parseObjectId(assignedUserInput.value, "assignedUser")
      : currentProgram.assignedUser?.toString() || null;

    if (nextUserType === "normal_user") {
      nextAssignedUser = null;
    } else {
      const premiumUser = await ensurePremiumUserAssignable(nextAssignedUser);
      nextAssignedUser = premiumUser._id;
    }

    updates.userType = nextUserType;
    updates.assignedUser = nextAssignedUser;
  }

  const descriptionInput = getField(parsedBody, ["programDescription", "description"]);
  if (descriptionInput.provided) {
    updates.programDescription = asNonEmptyString(descriptionInput.value);
  }

  const safetyNoteInput = getField(parsedBody, ["safetyNote"]);
  if (safetyNoteInput.provided) {
    updates.safetyNote = asNonEmptyString(safetyNoteInput.value);
  }

  const mobilityInput = getField(parsedBody, ["mobilityType", "programMobility"]);
  if (mobilityInput.provided) {
    updates.mobilityType = asNonEmptyString(mobilityInput.value);
  }

  const weekCountInput = getField(parsedBody, ["weekCount"]);
  if (weekCountInput.provided) {
    const weekCount = numberOrUndefined(weekCountInput.value, "weekCount", 1);
    updates.weekCount = weekCount ?? currentProgram.weekCount;
  }

  const programImagesInput = getField(parsedBody, ["programImages", "programImage", "coverImage"]);
  if (programImagesInput.provided) {
    updates.programImages = normalizeMediaList(programImagesInput.value);
  }

  const programThumbnailsInput = getField(parsedBody, ["programThumbnails", "programThumbnail", "thumbnailImage"]);
  if (programThumbnailsInput.provided) {
    updates.programThumbnails = normalizeMediaList(programThumbnailsInput.value);
  }

  const exercisesInput = getField(parsedBody, ["exercises", "exerciseList"]);
  if (exercisesInput.provided) {
    const exercises = normalizeExercises(exercisesInput.value);
    if (exercises.length === 0) {
      throw new AppError("At least one exercise is required.", httpStatus.BAD_REQUEST);
    }
    updates.exercises = exercises;
    updates.totalExercises = exercises.length;
  }

  const statusInput = getField(parsedBody, ["status"]);
  if (statusInput.provided) {
    const status = normalizeProgramStatus(statusInput.value);
    updates.status = status;

    if (status === "archived") {
      updates.isActive = false;
    } else if (!Object.hasOwn(updates, "isActive")) {
      updates.isActive = true;
    }
  }

  const isActiveInput = getField(parsedBody, ["isActive"]);
  if (isActiveInput.provided) {
    updates.isActive = parseBoolean(isActiveInput.value, "isActive");
    if (updates.isActive === false) {
      updates.status = "archived";
    }
  }

  return updates;
};

const buildUserAccessibleFilter = (user) => {
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

export const createProgram = catchAsync(async (req, res) => {
  const payload = await buildCreatePayload(req.body);

  const program = await Program.create({
    ...payload,
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });

  const populated = await Program.findById(program._id).populate("assignedUser", "firstName email");

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Program created successfully.",
    data: buildProgramDetails(populated),
  });
});

export const getAdminPrograms = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = {};

  if (req.query.userType) {
    filter.userType = normalizeUserType(req.query.userType);
  }

  if (req.query.status) {
    filter.status = normalizeProgramStatus(req.query.status);
  }

  if (Object.hasOwn(req.query, "isActive")) {
    filter.isActive = parseBoolean(req.query.isActive, "isActive");
  }

  if (req.query.assignedUser) {
    filter.assignedUser = parseObjectId(req.query.assignedUser, "assignedUser");
  }

  if (req.query.mobilityType) {
    filter.mobilityType = asNonEmptyString(req.query.mobilityType);
  }

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asNonEmptyString(req.query.search)), "i");
    filter.$or = [{ programName: pattern }, { programDescription: pattern }];
  }

  const [programs, total] = await Promise.all([
    Program.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("assignedUser", "firstName email"),
    Program.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: programs.map(buildProgramSummary),
    meta: buildPagination(page, limit, total),
  });
});

export const getAdminProgramById = catchAsync(async (req, res) => {
  const { programId } = req.params;

  if (!mongoose.isValidObjectId(programId)) {
    throw new AppError("Invalid program id.", httpStatus.BAD_REQUEST);
  }

  const program = await Program.findById(programId).populate("assignedUser", "firstName email");
  if (!program) {
    throw new AppError("Program not found.", httpStatus.NOT_FOUND);
  }

  res.status(httpStatus.OK).json({
    success: true,
    data: buildProgramDetails(program),
  });
});

export const updateAdminProgram = catchAsync(async (req, res) => {
  const { programId } = req.params;

  if (!mongoose.isValidObjectId(programId)) {
    throw new AppError("Invalid program id.", httpStatus.BAD_REQUEST);
  }

  const program = await Program.findById(programId);
  if (!program) {
    throw new AppError("Program not found.", httpStatus.NOT_FOUND);
  }

  const updates = await buildUpdatePayload(req.body, program);
  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields were provided for update.", httpStatus.BAD_REQUEST);
  }

  Object.assign(program, updates, { updatedBy: req.user._id });
  await program.save();

  const populated = await Program.findById(program._id).populate("assignedUser", "firstName email");

  res.status(httpStatus.OK).json({
    success: true,
    message: "Program updated successfully.",
    data: buildProgramDetails(populated),
  });
});

export const deleteAdminProgram = catchAsync(async (req, res) => {
  const { programId } = req.params;

  if (!mongoose.isValidObjectId(programId)) {
    throw new AppError("Invalid program id.", httpStatus.BAD_REQUEST);
  }

  const program = await Program.findById(programId);
  if (!program) {
    throw new AppError("Program not found.", httpStatus.NOT_FOUND);
  }

  program.isActive = false;
  program.status = "archived";
  program.updatedBy = req.user._id;
  await program.save({ validateBeforeSave: false });

  res.status(httpStatus.OK).json({
    success: true,
    message: "Program archived successfully.",
  });
});

export const listPremiumUsers = catchAsync(async (req, res) => {
  const search = asNonEmptyString(req.query.search);

  const query = {
    role: "user",
    isActive: true,
    selectedPlan: "premium_plan",
    subscriptionStatus: "active",
  };

  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    query.$or = [{ firstName: pattern }, { email: pattern }];
  }

  const users = await User.find(query)
    .sort({ firstName: 1, email: 1 })
    .limit(100)
    .select("firstName email selectedPlan subscriptionStatus");

  res.status(httpStatus.OK).json({
    success: true,
    data: users.map((user) => ({
      id: user._id,
      firstName: user.firstName,
      email: user.email,
      selectedPlan: user.selectedPlan,
      subscriptionStatus: user.subscriptionStatus,
    })),
  });
});

export const getExplorePrograms = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = {
    status: "published",
    isActive: true,
    userType: "normal_user",
  };

  if (req.query.programLevel) {
    filter.programLevel = normalizeProgramLevel(req.query.programLevel);
  }

  if (req.query.mobilityType) {
    filter.mobilityType = asNonEmptyString(req.query.mobilityType);
  }

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asNonEmptyString(req.query.search)), "i");
    filter.$or = [{ programName: pattern }, { programDescription: pattern }];
  }

  const [programs, total] = await Promise.all([
    Program.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Program.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: programs.map(buildProgramSummary),
    meta: buildPagination(page, limit, total),
  });
});

export const getMyPrograms = catchAsync(async (req, res) => {
  if (!isPremiumActiveUser(req.user)) {
    throw new AppError("Active premium subscription required to access personalized programs.", httpStatus.FORBIDDEN);
  }

  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = {
    status: "published",
    isActive: true,
    userType: "premium_user",
    assignedUser: req.user._id,
  };

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asNonEmptyString(req.query.search)), "i");
    filter.$or = [{ programName: pattern }, { programDescription: pattern }];
  }

  const [programs, total] = await Promise.all([
    Program.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Program.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: programs.map(buildProgramSummary),
    meta: buildPagination(page, limit, total),
  });
});

export const getProgramByIdForUser = catchAsync(async (req, res) => {
  const { programId } = req.params;

  if (!mongoose.isValidObjectId(programId)) {
    throw new AppError("Invalid program id.", httpStatus.BAD_REQUEST);
  }

  const program = await Program.findById(programId).populate("assignedUser", "firstName email");
  if (!program || !program.isActive) {
    throw new AppError("Program not found.", httpStatus.NOT_FOUND);
  }

  if (req.user.role === "admin") {
    return res.status(httpStatus.OK).json({
      success: true,
      data: buildProgramDetails(program),
    });
  }

  if (program.status !== "published") {
    throw new AppError("Program not found.", httpStatus.NOT_FOUND);
  }

  const isGlobalProgram = program.userType === "normal_user";
  const isAssignedPremiumProgram =
    isPremiumActiveUser(req.user) &&
    program.userType === "premium_user" &&
    program.assignedUser &&
    program.assignedUser._id.toString() === req.user._id.toString();

  if (!isGlobalProgram && !isAssignedPremiumProgram) {
    throw new AppError("You are not allowed to access this program.", httpStatus.FORBIDDEN);
  }

  return res.status(httpStatus.OK).json({
    success: true,
    data: buildProgramDetails(program),
  });
});

export const getAllAccessiblePrograms = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;
  const filter = buildUserAccessibleFilter(req.user);

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asNonEmptyString(req.query.search)), "i");
    filter.$and = [{ $or: [{ programName: pattern }, { programDescription: pattern }] }];
  }

  const [programs, total] = await Promise.all([
    Program.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Program.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: programs.map(buildProgramSummary),
    meta: buildPagination(page, limit, total),
  });
});
