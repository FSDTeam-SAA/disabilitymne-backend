import mongoose from "mongoose";
import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { isPremiumActiveUser } from "../utils/access.js";
import { mergeUploadedMediaIntoBody } from "../utils/uploadedMedia.js";
import { Exercise } from "../models/exercise.model.js";
import { Program } from "../models/program.model.js";
import { User } from "../models/user.model.js";

const EXERCISE_STATUSES = new Set(["draft", "published", "archived"]);
const EXERCISE_IMAGE_FIELDS = ["exerciseImages", "exerciseImage", "image"];
const TARGET_MUSCLE_IMAGE_FIELDS = ["targetMuscleImages", "targetMuscleImage", "muscleImages", "muscleImage"];
const DEMO_VIDEO_FIELDS = ["demoVideos", "demoVideo", "exerciseVideo", "exerciseVideos", "video"];

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

const normalizeExerciseStatus = (value) => {
  const normalized = asString(value).toLowerCase();
  if (!EXERCISE_STATUSES.has(normalized)) {
    throw new AppError("status must be one of: draft, published, archived.", httpStatus.BAD_REQUEST);
  }

  return normalized;
};

const normalizeUserType = (value) => {
  const cleaned = asString(value).toLowerCase().replace(/\s+/g, "_");

  if (!cleaned || cleaned === "all" || cleaned === "all_user" || cleaned === "normal" || cleaned === "normal_user") {
    return "all_user";
  }

  if (cleaned === "premium" || cleaned === "premium_user") {
    return "premium_user";
  }

  throw new AppError("userType must be either all_user or premium_user.", httpStatus.BAD_REQUEST);
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

const normalizeStringList = (rawValue) => {
  const value = parseMaybeJson(rawValue);
  if (value === undefined || value === null || value === "") return [];

  if (Array.isArray(value)) {
    return value
      .map((item) => asString(item))
      .map((item) => item.replace(/^[-\u2022*\u00B7]+\s*/, ""))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/\r?\n|,|\u2022/)
      .map((item) => item.trim().replace(/^[-\u2022*\u00B7]+\s*/, ""))
      .filter(Boolean);
  }

  return [];
};

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

const ensurePremiumUserAssignable = async (userId) => {
  const parsedId = parseObjectId(userId, "assignedUser");
  if (!parsedId) {
    throw new AppError("assignedUser is required for premium_user exercises.", httpStatus.BAD_REQUEST);
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
      "Assigned user must have an active premium subscription before receiving private exercises.",
      httpStatus.BAD_REQUEST
    );
  }

  return user;
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

const buildExerciseSummary = (exercise, programNames = []) => ({
  id: exercise._id,
  exerciseName: exercise.exerciseName,
  userType: exercise.userType,
  plan: exercise.userType,
  assignedUser: toAssignedUser(exercise.assignedUser),
  description: exercise.description,
  keyBenefits: exercise.keyBenefits || [],
  muscleGroups: exercise.muscleGroups || [],
  exerciseImage: exercise.exerciseImages?.[0] || null,
  demoVideo: exercise.demoVideos?.[0] || null,
  targetMuscleImage: exercise.targetMuscleImages?.[0] || null,
  exerciseImages: exercise.exerciseImages || [],
  targetMuscleImages: exercise.targetMuscleImages || [],
  demoVideos: exercise.demoVideos || [],
  isVisibleInLibrary: exercise.isVisibleInLibrary,
  status: exercise.status,
  isActive: exercise.isActive,
  programNames,
  programCount: programNames.length,
  createdAt: exercise.createdAt,
  updatedAt: exercise.updatedAt,
});

const buildExerciseDetails = (exercise, programNames = []) => buildExerciseSummary(exercise, programNames);

const getProgramUsageMap = async (exerciseIds) => {
  const idList = Array.isArray(exerciseIds)
    ? exerciseIds
        .map((id) => id?.toString?.() || null)
        .filter(Boolean)
    : [];

  if (idList.length === 0) {
    return new Map();
  }

  const usageMap = new Map(idList.map((id) => [id, []]));

  const programs = await Program.find({
    isActive: true,
    status: { $ne: "archived" },
    exerciseRefs: { $in: idList },
  }).select("programName exerciseRefs");

  for (const program of programs) {
    for (const exerciseId of program.exerciseRefs || []) {
      const key = exerciseId.toString();
      if (!usageMap.has(key)) continue;

      const names = usageMap.get(key);
      if (!names.includes(program.programName)) {
        names.push(program.programName);
      }
    }
  }

  return usageMap;
};

const buildCreatePayload = async (body) => {
  const parsedBody = body || {};

  const exerciseName = asString(getField(parsedBody, ["exerciseName", "name", "exerciseTitle", "title"]).value);
  if (!exerciseName) {
    throw new AppError("exerciseName is required.", httpStatus.BAD_REQUEST);
  }

  const userType = normalizeUserType(getField(parsedBody, ["userType", "plan"]).value || "all_user");
  const description = asString(getField(parsedBody, ["description", "exerciseDescription", "workoutDescription"]).value);
  const keyBenefits = normalizeStringList(getField(parsedBody, ["keyBenefits", "benefits"]).value);
  const muscleGroups = normalizeStringList(getField(parsedBody, ["muscleGroups", "targetMuscles", "tags"]).value);
  const exerciseImages = normalizeMediaList(getField(parsedBody, ["exerciseImages", "exerciseImage", "image"]).value);
  const targetMuscleImages = normalizeMediaList(
    getField(parsedBody, ["targetMuscleImages", "targetMuscleImage", "muscleImages", "muscleImage"]).value
  );
  const demoVideos = normalizeMediaList(
    getField(parsedBody, DEMO_VIDEO_FIELDS).value
  );
  const status = normalizeExerciseStatus(getField(parsedBody, ["status"]).value || "published");
  const isVisibleInLibrary = parseBoolean(
    getField(parsedBody, ["isVisibleInLibrary", "visibleInLibrary", "isVisible"]).value,
    "isVisibleInLibrary"
  );

  if (exerciseImages.length === 0) {
    throw new AppError("At least one exercise image is required.", httpStatus.BAD_REQUEST);
  }

  if (demoVideos.length === 0) {
    throw new AppError("At least one exercise demo video is required.", httpStatus.BAD_REQUEST);
  }

  let assignedUser = null;
  if (userType === "premium_user") {
    const assignedInput = getField(parsedBody, ["assignedUser", "assignedUserId", "targetUserId", "userId"]).value;
    const premiumUser = await ensurePremiumUserAssignable(assignedInput);
    assignedUser = premiumUser._id;
  }

  return {
    exerciseName,
    userType,
    assignedUser,
    description,
    keyBenefits,
    muscleGroups,
    exerciseImages,
    targetMuscleImages,
    demoVideos,
    status,
    isVisibleInLibrary: isVisibleInLibrary ?? true,
    isActive: status !== "archived",
  };
};

const buildUpdatePayload = async (body, currentExercise) => {
  const parsedBody = body || {};
  const updates = {};

  const nameInput = getField(parsedBody, ["exerciseName", "name", "exerciseTitle", "title"]);
  if (nameInput.provided) {
    const exerciseName = asString(nameInput.value);
    if (!exerciseName) {
      throw new AppError("exerciseName cannot be empty.", httpStatus.BAD_REQUEST);
    }
    updates.exerciseName = exerciseName;
  }

  const descriptionInput = getField(parsedBody, ["description", "exerciseDescription", "workoutDescription"]);
  if (descriptionInput.provided) {
    updates.description = asString(descriptionInput.value);
  }

  const keyBenefitsInput = getField(parsedBody, ["keyBenefits", "benefits"]);
  if (keyBenefitsInput.provided) {
    updates.keyBenefits = normalizeStringList(keyBenefitsInput.value);
  }

  const muscleGroupsInput = getField(parsedBody, ["muscleGroups", "targetMuscles", "tags"]);
  if (muscleGroupsInput.provided) {
    updates.muscleGroups = normalizeStringList(muscleGroupsInput.value);
  }

  const exerciseImagesInput = getField(parsedBody, ["exerciseImages", "exerciseImage", "image"]);
  if (exerciseImagesInput.provided) {
    const exerciseImages = normalizeMediaList(exerciseImagesInput.value);
    if (exerciseImages.length === 0) {
      throw new AppError("At least one exercise image is required.", httpStatus.BAD_REQUEST);
    }
    updates.exerciseImages = exerciseImages;
  }

  const targetMuscleImagesInput = getField(
    parsedBody,
    ["targetMuscleImages", "targetMuscleImage", "muscleImages", "muscleImage"]
  );
  if (targetMuscleImagesInput.provided) {
    updates.targetMuscleImages = normalizeMediaList(targetMuscleImagesInput.value);
  }

  const demoVideosInput = getField(parsedBody, DEMO_VIDEO_FIELDS);
  if (demoVideosInput.provided) {
    const demoVideos = normalizeMediaList(demoVideosInput.value);
    if (demoVideos.length === 0) {
      throw new AppError("At least one exercise demo video is required.", httpStatus.BAD_REQUEST);
    }
    updates.demoVideos = demoVideos;
  }

  const userTypeInput = getField(parsedBody, ["userType", "plan"]);
  const assignedUserInput = getField(parsedBody, ["assignedUser", "assignedUserId", "targetUserId", "userId"]);

  if (userTypeInput.provided || assignedUserInput.provided) {
    const nextUserType = userTypeInput.provided ? normalizeUserType(userTypeInput.value) : currentExercise.userType;
    let nextAssignedUser = assignedUserInput.provided
      ? parseObjectId(assignedUserInput.value, "assignedUser")
      : currentExercise.assignedUser?.toString() || null;

    if (nextUserType === "all_user") {
      nextAssignedUser = null;
    } else {
      const premiumUser = await ensurePremiumUserAssignable(nextAssignedUser);
      nextAssignedUser = premiumUser._id;
    }

    updates.userType = nextUserType;
    updates.assignedUser = nextAssignedUser;
  }

  const visibilityInput = getField(parsedBody, ["isVisibleInLibrary", "visibleInLibrary", "isVisible"]);
  if (visibilityInput.provided) {
    updates.isVisibleInLibrary = parseBoolean(visibilityInput.value, "isVisibleInLibrary");
  }

  const statusInput = getField(parsedBody, ["status"]);
  if (statusInput.provided) {
    const status = normalizeExerciseStatus(statusInput.value);
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
    $or: [{ userType: "all_user", isVisibleInLibrary: true }],
  };

  if (isPremiumActiveUser(user)) {
    filter.$or.push({ userType: "premium_user", assignedUser: user._id });
  }

  return filter;
};

const getExerciseBodyFromRequest = (req) =>
  mergeUploadedMediaIntoBody(req.body, req.files, [
    { target: "exerciseImages", fieldNames: EXERCISE_IMAGE_FIELDS },
    { target: "targetMuscleImages", fieldNames: TARGET_MUSCLE_IMAGE_FIELDS },
    { target: "demoVideos", fieldNames: DEMO_VIDEO_FIELDS },
  ]);

export const createExercise = catchAsync(async (req, res) => {
  const payload = await buildCreatePayload(getExerciseBodyFromRequest(req));

  const exercise = await Exercise.create({
    ...payload,
    createdBy: req.user._id,
    updatedBy: req.user._id,
  });

  const populated = await Exercise.findById(exercise._id).populate("assignedUser", "firstName email");

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Exercise created successfully.",
    data: buildExerciseDetails(populated),
  });
});

export const getAdminExercises = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = {};

  if (req.query.userType || req.query.plan) {
    filter.userType = normalizeUserType(req.query.userType || req.query.plan);
  }

  if (req.query.status) {
    filter.status = normalizeExerciseStatus(req.query.status);
  }

  if (Object.hasOwn(req.query, "isActive")) {
    filter.isActive = parseBoolean(req.query.isActive, "isActive");
  }

  if (Object.hasOwn(req.query, "isVisibleInLibrary")) {
    filter.isVisibleInLibrary = parseBoolean(req.query.isVisibleInLibrary, "isVisibleInLibrary");
  }

  if (req.query.assignedUser) {
    filter.assignedUser = parseObjectId(req.query.assignedUser, "assignedUser");
  }

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.$or = [
      { exerciseName: pattern },
      { description: pattern },
      { keyBenefits: { $elemMatch: pattern } },
      { muscleGroups: { $elemMatch: pattern } },
    ];
  }

  const [exercises, total] = await Promise.all([
    Exercise.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("assignedUser", "firstName email"),
    Exercise.countDocuments(filter),
  ]);

  const usageMap = await getProgramUsageMap(exercises.map((exercise) => exercise._id));

  res.status(httpStatus.OK).json({
    success: true,
    data: exercises.map((exercise) => buildExerciseSummary(exercise, usageMap.get(exercise._id.toString()) || [])),
    meta: buildPagination(page, limit, total),
  });
});

export const getAdminExerciseById = catchAsync(async (req, res) => {
  const { exerciseId } = req.params;
  if (!mongoose.isValidObjectId(exerciseId)) {
    throw new AppError("Invalid exercise id.", httpStatus.BAD_REQUEST);
  }

  const exercise = await Exercise.findById(exerciseId).populate("assignedUser", "firstName email");
  if (!exercise) {
    throw new AppError("Exercise not found.", httpStatus.NOT_FOUND);
  }

  const usageMap = await getProgramUsageMap([exercise._id]);

  res.status(httpStatus.OK).json({
    success: true,
    data: buildExerciseDetails(exercise, usageMap.get(exercise._id.toString()) || []),
  });
});

export const updateAdminExercise = catchAsync(async (req, res) => {
  const { exerciseId } = req.params;
  if (!mongoose.isValidObjectId(exerciseId)) {
    throw new AppError("Invalid exercise id.", httpStatus.BAD_REQUEST);
  }

  const exercise = await Exercise.findById(exerciseId);
  if (!exercise) {
    throw new AppError("Exercise not found.", httpStatus.NOT_FOUND);
  }

  const updates = await buildUpdatePayload(getExerciseBodyFromRequest(req), exercise);
  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields were provided for update.", httpStatus.BAD_REQUEST);
  }

  Object.assign(exercise, updates, { updatedBy: req.user._id });
  await exercise.save();

  const populated = await Exercise.findById(exercise._id).populate("assignedUser", "firstName email");
  const usageMap = await getProgramUsageMap([exercise._id]);

  res.status(httpStatus.OK).json({
    success: true,
    message: "Exercise updated successfully.",
    data: buildExerciseDetails(populated, usageMap.get(exercise._id.toString()) || []),
  });
});

export const updateExerciseVisibility = catchAsync(async (req, res) => {
  const { exerciseId } = req.params;
  if (!mongoose.isValidObjectId(exerciseId)) {
    throw new AppError("Invalid exercise id.", httpStatus.BAD_REQUEST);
  }

  const exercise = await Exercise.findById(exerciseId);
  if (!exercise) {
    throw new AppError("Exercise not found.", httpStatus.NOT_FOUND);
  }

  const visibilityInput = getField(req.body || {}, ["isVisibleInLibrary", "visibleInLibrary", "isVisible"]);
  if (visibilityInput.provided) {
    exercise.isVisibleInLibrary = parseBoolean(visibilityInput.value, "isVisibleInLibrary");
  } else {
    exercise.isVisibleInLibrary = !exercise.isVisibleInLibrary;
  }

  exercise.updatedBy = req.user._id;
  await exercise.save({ validateBeforeSave: false });

  res.status(httpStatus.OK).json({
    success: true,
    message: "Exercise visibility updated successfully.",
    data: {
      id: exercise._id,
      isVisibleInLibrary: exercise.isVisibleInLibrary,
    },
  });
});

export const deleteAdminExercise = catchAsync(async (req, res) => {
  const { exerciseId } = req.params;
  if (!mongoose.isValidObjectId(exerciseId)) {
    throw new AppError("Invalid exercise id.", httpStatus.BAD_REQUEST);
  }

  const exercise = await Exercise.findById(exerciseId);
  if (!exercise) {
    throw new AppError("Exercise not found.", httpStatus.NOT_FOUND);
  }

  exercise.isActive = false;
  exercise.status = "archived";
  exercise.updatedBy = req.user._id;
  await exercise.save({ validateBeforeSave: false });

  const affectedPrograms = await Program.find({ exerciseRefs: exercise._id });
  await Promise.all(
    affectedPrograms.map(async (program) => {
      program.exerciseRefs = (program.exerciseRefs || []).filter(
        (exerciseRefId) => exerciseRefId.toString() !== exercise._id.toString()
      );
      program.totalExercises = program.exerciseRefs.length;
      program.updatedBy = req.user._id;
      await program.save({ validateBeforeSave: false });
    })
  );

  res.status(httpStatus.OK).json({
    success: true,
    message: "Exercise archived successfully.",
    data: {
      removedFromPrograms: affectedPrograms.length,
    },
  });
});

export const listPremiumUsersForExercises = catchAsync(async (req, res) => {
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

export const getPublicExerciseLibrary = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = {
    status: "published",
    isActive: true,
    userType: "all_user",
    isVisibleInLibrary: true,
  };

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.$or = [
      { exerciseName: pattern },
      { description: pattern },
      { keyBenefits: { $elemMatch: pattern } },
      { muscleGroups: { $elemMatch: pattern } },
    ];
  }

  const [exercises, total] = await Promise.all([
    Exercise.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Exercise.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: exercises.map((exercise) => buildExerciseSummary(exercise)),
    meta: buildPagination(page, limit, total),
  });
});

export const getMyPrivateExercises = catchAsync(async (req, res) => {
  if (!isPremiumActiveUser(req.user)) {
    throw new AppError("Active premium subscription required to access private exercises.", httpStatus.FORBIDDEN);
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
    filter.$or = [
      { exerciseName: pattern },
      { description: pattern },
      { keyBenefits: { $elemMatch: pattern } },
      { muscleGroups: { $elemMatch: pattern } },
    ];
  }

  const [exercises, total] = await Promise.all([
    Exercise.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Exercise.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: exercises.map((exercise) => buildExerciseSummary(exercise)),
    meta: buildPagination(page, limit, total),
  });
});

export const getAllAccessibleExercises = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const filter = buildUserAccessibleFilter(req.user);

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.$and = [
      {
        $or: [
          { exerciseName: pattern },
          { description: pattern },
          { keyBenefits: { $elemMatch: pattern } },
          { muscleGroups: { $elemMatch: pattern } },
        ],
      },
    ];
  }

  const [exercises, total] = await Promise.all([
    Exercise.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Exercise.countDocuments(filter),
  ]);

  res.status(httpStatus.OK).json({
    success: true,
    data: exercises.map((exercise) => buildExerciseSummary(exercise)),
    meta: buildPagination(page, limit, total),
  });
});

export const getExerciseByIdForUser = catchAsync(async (req, res) => {
  const { exerciseId } = req.params;
  if (!mongoose.isValidObjectId(exerciseId)) {
    throw new AppError("Invalid exercise id.", httpStatus.BAD_REQUEST);
  }

  const exercise = await Exercise.findById(exerciseId).populate("assignedUser", "firstName email");
  if (!exercise || !exercise.isActive) {
    throw new AppError("Exercise not found.", httpStatus.NOT_FOUND);
  }

  if (req.user.role === "admin") {
    const usageMap = await getProgramUsageMap([exercise._id]);
    return res.status(httpStatus.OK).json({
      success: true,
      data: buildExerciseDetails(exercise, usageMap.get(exercise._id.toString()) || []),
    });
  }

  if (exercise.status !== "published") {
    throw new AppError("Exercise not found.", httpStatus.NOT_FOUND);
  }

  const isPublicExercise = exercise.userType === "all_user";
  const isAssignedPremiumExercise =
    isPremiumActiveUser(req.user) &&
    exercise.userType === "premium_user" &&
    exercise.assignedUser &&
    exercise.assignedUser._id.toString() === req.user._id.toString();

  if (!isPublicExercise && !isAssignedPremiumExercise) {
    throw new AppError("You are not allowed to access this exercise.", httpStatus.FORBIDDEN);
  }

  return res.status(httpStatus.OK).json({
    success: true,
    data: buildExerciseDetails(exercise),
  });
});
