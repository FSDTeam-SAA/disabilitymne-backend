import mongoose from "mongoose";
import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { isPremiumActiveUser } from "../utils/access.js";
import { Exercise } from "../models/exercise.model.js";
import { Program } from "../models/program.model.js";
import { User } from "../models/user.model.js";

const PROGRAM_LEVELS = new Set(["beginner", "intermediate", "advanced"]);
const PROGRAM_USER_TYPES = new Set(["normal_user", "premium_user"]);
const PROGRAM_STATUSES = new Set(["draft", "published", "archived"]);

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

const getField = (body, keys) => {
  for (const key of keys) {
    if (Object.hasOwn(body, key)) {
      return { provided: true, value: body[key] };
    }
  }

  return { provided: false, value: undefined };
};

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const escapeRegex = (input) => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseObjectId = (value, fieldName) => {
  const id = asString(value);
  if (!id) return null;

  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(`${fieldName} must be a valid id.`, httpStatus.BAD_REQUEST);
  }

  return id;
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

const parsePage = (value) => {
  const page = Number(value || 1);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
};

const parseLimit = (value, defaultValue = 10, maxValue = 100) => {
  const limit = Number(value || defaultValue);
  if (!Number.isFinite(limit) || limit <= 0) return defaultValue;
  return Math.min(Math.floor(limit), maxValue);
};

const buildPagination = (page, limit, total) => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});

const normalizeProgramLevel = (value) => {
  const normalized = asString(value).toLowerCase().replace(/\s+/g, "_");
  if (!PROGRAM_LEVELS.has(normalized)) {
    throw new AppError("programLevel must be one of: beginner, intermediate, advanced.", httpStatus.BAD_REQUEST);
  }

  return normalized;
};

const normalizeProgramUserType = (value) => {
  const cleaned = asString(value).toLowerCase().replace(/\s+/g, "_");

  if (
    !cleaned ||
    cleaned === "normal" ||
    cleaned === "normal_user" ||
    cleaned === "all" ||
    cleaned === "all_user"
  ) {
    return "normal_user";
  }

  if (cleaned === "premium" || cleaned === "premium_user") {
    return "premium_user";
  }

  if (!PROGRAM_USER_TYPES.has(cleaned)) {
    throw new AppError("userType must be either normal_user or premium_user.", httpStatus.BAD_REQUEST);
  }

  return cleaned;
};

const normalizeProgramStatus = (value) => {
  const normalized = asString(value).toLowerCase();
  if (!PROGRAM_STATUSES.has(normalized)) {
    throw new AppError("status must be one of: draft, published, archived.", httpStatus.BAD_REQUEST);
  }

  return normalized;
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

const parseDurationMinutes = (value, durationLabel) => {
  const direct = parseNumber(value, "durationMinutes", 1, false);
  if (direct !== undefined) return Math.round(direct);

  const label = asString(durationLabel);
  const matched = label.match(/\d+/);
  if (matched) {
    return Math.max(1, Number(matched[0]));
  }

  throw new AppError(
    "durationMinutes is required (or provide a parseable number in programDuration).",
    httpStatus.BAD_REQUEST
  );
};

const extractDurationMinutesFromLabel = (durationLabel) => {
  const label = asString(durationLabel);
  if (!label) return undefined;

  const matched = label.match(/\d+/);
  if (!matched) return undefined;

  const value = Number(matched[0]);
  if (!Number.isFinite(value) || value < 1) return undefined;

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

  if (typeof value !== "object") return null;

  const url = asString(value.url || value.path || value.secure_url);
  if (!url) return null;

  const size = Number(value.size);

  return {
    url,
    publicId: asString(value.publicId || value.public_id || value.filename),
    mimetype: asString(value.mimetype || value.resource_type || value.format),
    size: Number.isFinite(size) && size > 0 ? size : 0,
  };
};

const normalizeMediaList = (rawValue) => {
  const value = parseMaybeJson(rawValue);
  if (value === undefined || value === null || value === "") return [];

  if (Array.isArray(value)) {
    return value.map(normalizeMediaAsset).filter(Boolean);
  }

  const single = normalizeMediaAsset(value);
  return single ? [single] : [];
};

const parseExerciseIds = (rawValue) => {
  const value = parseMaybeJson(rawValue);
  if (value === undefined || value === null || value === "") return [];

  let candidates = [];

  if (Array.isArray(value)) {
    candidates = value;
  } else if (typeof value === "string") {
    candidates = value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  } else {
    candidates = [value];
  }

  const unique = new Set();
  const ids = [];

  for (const item of candidates) {
    let candidateId = item;

    if (item && typeof item === "object") {
      candidateId = item.exerciseId || item.id || item._id || null;
    }

    const id = asString(candidateId);
    if (!id) continue;

    if (!mongoose.isValidObjectId(id)) {
      throw new AppError(`Invalid exercise id: ${id}`, httpStatus.BAD_REQUEST);
    }

    if (!unique.has(id)) {
      unique.add(id);
      ids.push(id);
    }
  }

  return ids;
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

  if (!isPremiumActiveUser(user)) {
    throw new AppError(
      "Assigned user must have an active premium subscription before receiving private programs.",
      httpStatus.BAD_REQUEST
    );
  }

  return user;
};

const validateLinkedExercises = async ({ exerciseIds, userType, assignedUserId }) => {
  if (!Array.isArray(exerciseIds) || exerciseIds.length === 0) {
    throw new AppError("At least one exercise must be selected.", httpStatus.BAD_REQUEST);
  }

  const exercises = await Exercise.find({
    _id: { $in: exerciseIds },
    isActive: true,
    status: "published",
  }).select("_id userType assignedUser status isActive");

  if (exercises.length !== exerciseIds.length) {
    const found = new Set(exercises.map((exercise) => exercise._id.toString()));
    const missing = exerciseIds.filter((exerciseId) => !found.has(exerciseId));
    throw new AppError(
      `Some selected exercises are missing, archived, or unpublished: ${missing.join(", ")}`,
      httpStatus.BAD_REQUEST
    );
  }

  const byId = new Map(exercises.map((exercise) => [exercise._id.toString(), exercise]));

  if (userType === "normal_user") {
    const invalid = exerciseIds
      .map((exerciseId) => byId.get(exerciseId))
      .find((exercise) => exercise && exercise.userType !== "all_user");

    if (invalid) {
      throw new AppError(
        "normal_user programs can only include exercises with plan all_user.",
        httpStatus.BAD_REQUEST
      );
    }
  }

  if (userType === "premium_user") {
    if (!assignedUserId) {
      throw new AppError("assignedUser is required for premium_user programs.", httpStatus.BAD_REQUEST);
    }

    for (const exerciseId of exerciseIds) {
      const exercise = byId.get(exerciseId);
      if (!exercise) continue;

      if (exercise.userType === "all_user") continue;

      const isMatchingPrivateExercise =
        exercise.userType === "premium_user" &&
        exercise.assignedUser &&
        exercise.assignedUser.toString() === assignedUserId.toString();

      if (!isMatchingPrivateExercise) {
        throw new AppError(
          "Premium programs can only include all_user exercises or premium_user exercises assigned to the same premium user.",
          httpStatus.BAD_REQUEST
        );
      }
    }
  }

  return exerciseIds.map((exerciseId) => new mongoose.Types.ObjectId(exerciseId));
};

const toAssignedUser = (assignedUser) => {
  if (assignedUser && typeof assignedUser === "object" && assignedUser._id) {
    return {
      id: assignedUser._id,
      firstName: assignedUser.firstName,
      email: assignedUser.email,
    };
  }

  return assignedUser || null;
};

const mapExerciseFromLibrary = (exercise, index) => ({
  id: exercise._id,
  exerciseName: exercise.exerciseName,
  name: exercise.exerciseName,
  order: index + 1,
  userType: exercise.userType,
  plan: exercise.userType,
  assignedUser: toAssignedUser(exercise.assignedUser),
  description: exercise.description || "",
  keyBenefits: exercise.keyBenefits || [],
  muscleGroups: exercise.muscleGroups || [],
  exerciseImages: exercise.exerciseImages || [],
  image: exercise.exerciseImages?.[0] || null,
  targetMuscleImages: exercise.targetMuscleImages || [],
  targetMuscleImage: exercise.targetMuscleImages?.[0] || null,
  demoVideos: exercise.demoVideos || [],
  demoVideo: exercise.demoVideos?.[0] || null,
  isVisibleInLibrary: exercise.isVisibleInLibrary,
});

const mapLegacyExercise = (exercise) => {
  const demoVideos =
    Array.isArray(exercise.demoVideos) && exercise.demoVideos.length > 0
      ? exercise.demoVideos
      : exercise.demoVideo
        ? [exercise.demoVideo]
        : [];

  const exerciseImages =
    Array.isArray(exercise.exerciseImages) && exercise.exerciseImages.length > 0
      ? exercise.exerciseImages
      : exercise.image
        ? [exercise.image]
        : [];

  const targetMuscleImages = Array.isArray(exercise.targetMuscleImages) ? exercise.targetMuscleImages : [];

  return {
    id: null,
    exerciseName: exercise.name,
    name: exercise.name,
    order: exercise.order,
    description: exercise.description || "",
    keyBenefits: exercise.keyBenefits || [],
    demoVideos,
    demoVideo: demoVideos[0] || null,
    exerciseImages,
    image: exerciseImages[0] || null,
    targetMuscleImages,
    targetMuscleImage: targetMuscleImages[0] || null,
    defaultSets: exercise.defaultSets || [],
    durationSeconds: exercise.durationSeconds ?? null,
    calories: exercise.calories ?? null,
  };
};

const buildProgramSummary = (program) => ({
  id: program._id,
  programName: program.programName,
  programDuration: program.programDuration,
  durationMinutes: program.durationMinutes,
  programLevel: program.programLevel,
  userType: program.userType,
  plan: program.userType,
  assignedUser: toAssignedUser(program.assignedUser),
  programDescription: program.programDescription,
  safetyNote: program.safetyNote,
  mobilityType: program.mobilityType,
  weekCount: program.weekCount,
  totalExercises: program.totalExercises,
  exerciseIds: Array.isArray(program.exerciseRefs) ? program.exerciseRefs.map((exerciseRef) => exerciseRef.toString()) : [],
  status: program.status,
  isActive: program.isActive,
  programImage: program.programImages?.[0] || null,
  programThumbnail: program.programThumbnails?.[0] || null,
  programImages: program.programImages || [],
  programThumbnails: program.programThumbnails || [],
  createdAt: program.createdAt,
  updatedAt: program.updatedAt,
});

const buildProgramDetails = (program) => {
  const populatedLibraryExercises =
    Array.isArray(program.exerciseRefs) && program.exerciseRefs.length > 0 && typeof program.exerciseRefs[0] === "object"
      ? program.exerciseRefs
      : [];

  const exercises =
    populatedLibraryExercises.length > 0
      ? populatedLibraryExercises.map((exercise, index) => mapExerciseFromLibrary(exercise, index))
      : Array.isArray(program.exercises)
        ? program.exercises.map(mapLegacyExercise)
        : [];

  return {
    ...buildProgramSummary(program),
    totalExercises: exercises.length || program.totalExercises || 0,
    exercises,
  };
};

const buildCreatePayload = async (body) => {
  const parsedBody = body || {};

  const programName = asString(getField(parsedBody, ["programName", "name"]).value);
  if (!programName) {
    throw new AppError("programName is required.", httpStatus.BAD_REQUEST);
  }

  const userType = normalizeProgramUserType(getField(parsedBody, ["userType", "plan"]).value || "normal_user");
  const programLevel = normalizeProgramLevel(getField(parsedBody, ["programLevel", "level"]).value || "beginner");

  const rawDurationLabel = getField(parsedBody, ["programDuration", "duration"]).value;
  let programDuration = asString(rawDurationLabel);
  const durationMinutes = parseDurationMinutes(getField(parsedBody, ["durationMinutes"]).value, programDuration);
  if (!programDuration) {
    programDuration = `${durationMinutes} Minute`;
  }

  const programDescription = asString(getField(parsedBody, ["programDescription", "description"]).value);
  const safetyNote = asString(getField(parsedBody, ["safetyNote"]).value);
  const mobilityType = asString(getField(parsedBody, ["mobilityType", "programMobility"]).value);
  const weekCount = parseNumber(getField(parsedBody, ["weekCount"]).value, "weekCount", 1, false) ?? 12;

  const programImages = normalizeMediaList(getField(parsedBody, ["programImages", "programImage", "coverImage"]).value);
  if (programImages.length === 0) {
    throw new AppError("At least one program image is required.", httpStatus.BAD_REQUEST);
  }

  const programThumbnails = normalizeMediaList(
    getField(parsedBody, ["programThumbnails", "programThumbnail", "thumbnailImage"]).value
  );

  let assignedUser = null;
  if (userType === "premium_user") {
    const assignedInput = getField(parsedBody, ["assignedUser", "assignedUserId", "targetUserId", "userId"]).value;
    const premiumUser = await ensurePremiumUserAssignable(assignedInput);
    assignedUser = premiumUser._id;
  }

  const rawExerciseSelection = getField(parsedBody, [
    "exerciseIds",
    "exerciseRefs",
    "selectedExerciseIds",
    "selectedExercises",
    "exercises",
  ]).value;
  const selectedExerciseIds = parseExerciseIds(rawExerciseSelection);
  const exerciseRefs = await validateLinkedExercises({
    exerciseIds: selectedExerciseIds,
    userType,
    assignedUserId: assignedUser,
  });

  const status = normalizeProgramStatus(getField(parsedBody, ["status"]).value || "published");

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
    exerciseRefs,
    exercises: [],
    totalExercises: exerciseRefs.length,
    status,
    isActive: status !== "archived",
  };
};

const buildUpdatePayload = async (body, currentProgram) => {
  const parsedBody = body || {};
  const updates = {};

  const nameInput = getField(parsedBody, ["programName", "name"]);
  if (nameInput.provided) {
    const programName = asString(nameInput.value);
    if (!programName) {
      throw new AppError("programName cannot be empty.", httpStatus.BAD_REQUEST);
    }
    updates.programName = programName;
  }

  const durationLabelInput = getField(parsedBody, ["programDuration", "duration"]);
  const durationMinutesInput = getField(parsedBody, ["durationMinutes"]);

  if (durationLabelInput.provided) {
    const label = asString(durationLabelInput.value);
    if (!label) {
      throw new AppError("programDuration cannot be empty.", httpStatus.BAD_REQUEST);
    }
    updates.programDuration = label;

    if (!durationMinutesInput.provided) {
      updates.durationMinutes = extractDurationMinutesFromLabel(label) ?? currentProgram.durationMinutes;
    }
  }

  if (durationMinutesInput.provided) {
    const durationMinutes = parseDurationMinutes(durationMinutesInput.value, updates.programDuration || currentProgram.programDuration);
    updates.durationMinutes = durationMinutes;
    if (!durationLabelInput.provided) {
      updates.programDuration = `${durationMinutes} Minute`;
    }
  }

  const levelInput = getField(parsedBody, ["programLevel", "level"]);
  if (levelInput.provided) {
    updates.programLevel = normalizeProgramLevel(levelInput.value);
  }

  const descriptionInput = getField(parsedBody, ["programDescription", "description"]);
  if (descriptionInput.provided) {
    updates.programDescription = asString(descriptionInput.value);
  }

  const safetyNoteInput = getField(parsedBody, ["safetyNote"]);
  if (safetyNoteInput.provided) {
    updates.safetyNote = asString(safetyNoteInput.value);
  }

  const mobilityInput = getField(parsedBody, ["mobilityType", "programMobility"]);
  if (mobilityInput.provided) {
    updates.mobilityType = asString(mobilityInput.value);
  }

  const weekCountInput = getField(parsedBody, ["weekCount"]);
  if (weekCountInput.provided) {
    updates.weekCount = parseNumber(weekCountInput.value, "weekCount", 1, false) ?? currentProgram.weekCount;
  }

  const imagesInput = getField(parsedBody, ["programImages", "programImage", "coverImage"]);
  if (imagesInput.provided) {
    updates.programImages = normalizeMediaList(imagesInput.value);
  }

  const thumbnailsInput = getField(parsedBody, ["programThumbnails", "programThumbnail", "thumbnailImage"]);
  if (thumbnailsInput.provided) {
    updates.programThumbnails = normalizeMediaList(thumbnailsInput.value);
  }

  const userTypeInput = getField(parsedBody, ["userType", "plan"]);
  const assignedUserInput = getField(parsedBody, ["assignedUser", "assignedUserId", "targetUserId", "userId"]);

  if (userTypeInput.provided || assignedUserInput.provided) {
    const nextUserType = userTypeInput.provided
      ? normalizeProgramUserType(userTypeInput.value)
      : currentProgram.userType;

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

  const exerciseSelectionInput = getField(parsedBody, [
    "exerciseIds",
    "exerciseRefs",
    "selectedExerciseIds",
    "selectedExercises",
    "exercises",
  ]);

  if (exerciseSelectionInput.provided) {
    const selectedExerciseIds = parseExerciseIds(exerciseSelectionInput.value);
    updates.exerciseRefs = selectedExerciseIds.map((exerciseId) => new mongoose.Types.ObjectId(exerciseId));
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

  const shouldValidateLinkedExercises =
    Object.hasOwn(updates, "exerciseRefs") || Object.hasOwn(updates, "userType") || Object.hasOwn(updates, "assignedUser");

  if (shouldValidateLinkedExercises) {
    const nextUserType = updates.userType || currentProgram.userType;
    const nextAssignedUser = Object.hasOwn(updates, "assignedUser")
      ? updates.assignedUser
      : currentProgram.assignedUser?.toString() || null;
    const nextExerciseIds = (updates.exerciseRefs || currentProgram.exerciseRefs || []).map((exerciseRef) =>
      exerciseRef.toString()
    );

    const validatedRefs = await validateLinkedExercises({
      exerciseIds: nextExerciseIds,
      userType: nextUserType,
      assignedUserId: nextAssignedUser,
    });

    updates.exerciseRefs = validatedRefs;
    updates.exercises = [];
    updates.totalExercises = validatedRefs.length;
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

const populateProgramQuery = (query) =>
  query
    .populate("assignedUser", "firstName email")
    .populate({
      path: "exerciseRefs",
      select: "exerciseName userType assignedUser description keyBenefits muscleGroups exerciseImages targetMuscleImages demoVideos isVisibleInLibrary status isActive",
      populate: {
        path: "assignedUser",
        select: "firstName email",
      },
    });

export const createProgram = catchAsync(async (req, res) => {
  const payload = await buildCreatePayload(req.body);

  const program = await Program.create({
    ...payload,
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });

  const populated = await populateProgramQuery(Program.findById(program._id));

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

  if (req.query.userType || req.query.plan) {
    filter.userType = normalizeProgramUserType(req.query.userType || req.query.plan);
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
    filter.mobilityType = asString(req.query.mobilityType);
  }

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
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

  const program = await populateProgramQuery(Program.findById(programId));
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

  const populated = await populateProgramQuery(Program.findById(program._id));

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
  const search = asString(req.query.search);

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
    filter.mobilityType = asString(req.query.mobilityType);
  }

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
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
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
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

  const program = await populateProgramQuery(Program.findById(programId));
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
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
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
