import mongoose from "mongoose";
import httpStatus from "http-status";
import fs from "node:fs/promises";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { isPremiumActiveUser } from "../utils/access.js";
import { toMediaUrl, toMediaUrlList } from "../utils/mediaResponse.js";
import { collectTrackedProgramIdsForUser, touchUserProgram } from "../utils/userProgramTracker.js";
import { mergeUploadedMediaIntoBody } from "../utils/uploadedMedia.js";
import { deleteCloudinaryImageByPublicId, uploadImageFileToCloudinary } from "../services/cloudinary.service.js";
import { Exercise } from "../models/exercise.model.js";
import { Program } from "../models/program.model.js";
import { UserExerciseSetting } from "../models/userExerciseSetting.model.js";
import { UserProgram } from "../models/userProgram.model.js";
import { User } from "../models/user.model.js";
import { getPlanKeyVariants } from "../constants/subscriptionPlans.js";

const PROGRAM_LEVELS = new Set(["beginner", "intermediate", "advanced"]);
const PROGRAM_USER_TYPES = new Set(["normal_user", "premium_user"]);
const PROGRAM_STATUSES = new Set(["draft", "published", "archived"]);
const PROGRAM_IMAGE_FIELDS = ["programImages", "programImage", "coverImage"];
const PROGRAM_THUMBNAIL_FIELDS = ["programThumbnails", "programThumbnail", "thumbnailImage"];
const CLOUDINARY_PROGRAM_IMAGE_FOLDER = "programs/images";
const CLOUDINARY_PROGRAM_THUMBNAIL_FOLDER = "programs/thumbnails";
const PREMIUM_PLAN_KEYS = getPlanKeyVariants("premium");
const WEEKDAY_LABELS = {
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
  7: "Sun",
};
const DEFAULT_WORKOUT_DAY_INDICES = [1, 3, 5];

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

const normalizeUploadedFiles = (files) => {
  if (!files) return {};

  if (Array.isArray(files)) {
    return files.reduce((acc, file) => {
      const fieldName = asString(file?.fieldname);
      if (!fieldName) return acc;

      if (!acc[fieldName]) {
        acc[fieldName] = [];
      }

      acc[fieldName].push(file);
      return acc;
    }, {});
  }

  return files;
};

const getUploadedFilesByFieldNames = (files, fieldNames = []) => {
  const groupedFiles = normalizeUploadedFiles(files);
  const uploadedFiles = [];

  for (const fieldName of fieldNames) {
    const fieldFiles = groupedFiles[fieldName];
    if (Array.isArray(fieldFiles) && fieldFiles.length > 0) {
      uploadedFiles.push(...fieldFiles);
    }
  }

  return uploadedFiles;
};

const cleanupTemporaryUpload = async (file) => {
  const filePath = asString(file?.path);
  if (!filePath) return;

  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore cleanup errors for temporary upload files.
  }
};

const cleanupTemporaryUploads = async (files = []) => {
  await Promise.all(files.map((file) => cleanupTemporaryUpload(file)));
};

const uploadImagesToCloudinary = async (files, folder, failureMessage) => {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  try {
    return await Promise.all(
      files.map((file) =>
        uploadImageFileToCloudinary(file, {
          folder,
        })
      )
    );
  } catch (error) {
    throw new AppError(asString(error?.message) || failureMessage, httpStatus.INTERNAL_SERVER_ERROR);
  } finally {
    await cleanupTemporaryUploads(files);
  }
};

const extractCloudinaryPublicIdFromUrl = (url) => {
  const rawUrl = asString(url);
  if (!rawUrl || !/res\.cloudinary\.com/i.test(rawUrl)) {
    return "";
  }

  try {
    const parsed = new URL(rawUrl);
    const marker = "/image/upload/";
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex < 0) {
      return "";
    }

    let publicIdPath = parsed.pathname.slice(markerIndex + marker.length);
    publicIdPath = publicIdPath.replace(/^v\d+\//, "");
    publicIdPath = publicIdPath.replace(/\.[^/.]+$/, "");

    return decodeURIComponent(publicIdPath);
  } catch {
    return "";
  }
};

const getMediaAssetPublicId = (asset) =>
  asString(asset?.publicId) || extractCloudinaryPublicIdFromUrl(asString(asset?.url));

const buildMediaAssetComparisonKey = (asset) => {
  const publicId = getMediaAssetPublicId(asset);
  if (publicId) {
    return `public:${publicId}`;
  }

  const url = asString(asset?.url);
  if (url) {
    return `url:${url}`;
  }

  return "";
};

const preserveExistingMediaMetadata = (nextAssets, existingAssets) => {
  const normalizedNext = normalizeMediaList(nextAssets);
  const normalizedExisting = normalizeMediaList(existingAssets);

  const existingByUrl = new Map(
    normalizedExisting
      .map((asset) => [asString(asset.url), asset])
      .filter(([url]) => Boolean(url))
  );

  return normalizedNext.map((asset) => {
    const url = asString(asset.url);
    const matchedExisting = existingByUrl.get(url);
    const size = Number(asset.size);

    if (!matchedExisting) {
      return asset;
    }

    const existingSize = Number(matchedExisting.size);

    return {
      url,
      publicId: asString(asset.publicId || matchedExisting.publicId),
      mimetype: asString(asset.mimetype || matchedExisting.mimetype),
      size:
        Number.isFinite(size) && size > 0
          ? size
          : Number.isFinite(existingSize) && existingSize > 0
            ? existingSize
            : 0,
    };
  });
};

const resolveRemovedCloudinaryPublicIds = (previousAssets, nextAssets) => {
  const previous = normalizeMediaList(previousAssets);
  const next = normalizeMediaList(nextAssets);
  const nextKeys = new Set(next.map((asset) => buildMediaAssetComparisonKey(asset)).filter(Boolean));
  const removedPublicIds = [];

  for (const previousAsset of previous) {
    const key = buildMediaAssetComparisonKey(previousAsset);
    if (!key || nextKeys.has(key)) {
      continue;
    }

    const publicId = getMediaAssetPublicId(previousAsset);
    if (publicId) {
      removedPublicIds.push(publicId);
    }
  }

  return [...new Set(removedPublicIds)];
};

const deleteCloudinaryAssetsByPublicIds = async (publicIds = []) => {
  const uniquePublicIds = [...new Set(publicIds.map((item) => asString(item)).filter(Boolean))];
  if (uniquePublicIds.length === 0) {
    return;
  }

  await Promise.allSettled(uniquePublicIds.map((publicId) => deleteCloudinaryImageByPublicId(publicId)));
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
      candidateId = item.exerciseId || item.id || item._id || item;
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

const normalizeDayIndex = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const integer = Math.floor(parsed);
  if (integer < 1 || integer > 7) return null;
  return integer;
};

const distributeExerciseIdsAcrossDays = (exerciseIds, dayIndices = DEFAULT_WORKOUT_DAY_INDICES) => {
  const normalizedIds = Array.isArray(exerciseIds) ? exerciseIds.filter(Boolean) : [];
  const normalizedDayIndices = (Array.isArray(dayIndices) ? dayIndices : [])
    .map((dayIndex) => normalizeDayIndex(dayIndex))
    .filter(Boolean);

  if (normalizedIds.length === 0 || normalizedDayIndices.length === 0) {
    return [];
  }

  const grouped = new Map(normalizedDayIndices.map((dayIndex) => [dayIndex, []]));

  for (let index = 0; index < normalizedIds.length; index += 1) {
    const dayIndex = normalizedDayIndices[index % normalizedDayIndices.length];
    grouped.get(dayIndex).push(normalizedIds[index]);
  }

  return normalizedDayIndices
    .map((dayIndex) => ({
      dayIndex,
      exerciseIds: grouped.get(dayIndex) || [],
    }))
    .filter((day) => day.exerciseIds.length > 0);
};

const parseWorkoutDays = (rawValue) => {
  const value = parseMaybeJson(rawValue);
  if (value === undefined || value === null || value === "") return [];

  if (!Array.isArray(value)) {
    throw new AppError("workoutDays must be an array.", httpStatus.BAD_REQUEST);
  }

  const parsedDays = [];
  const seenDayIndices = new Set();

  for (const rawDay of value) {
    if (!rawDay || typeof rawDay !== "object") {
      throw new AppError("Each workout day must be an object.", httpStatus.BAD_REQUEST);
    }

    const dayIndex = normalizeDayIndex(rawDay.dayIndex);
    if (!dayIndex) {
      throw new AppError("workoutDays.dayIndex must be an integer between 1 and 7.", httpStatus.BAD_REQUEST);
    }

    if (seenDayIndices.has(dayIndex)) {
      throw new AppError(`Duplicate workout day index found: ${dayIndex}.`, httpStatus.BAD_REQUEST);
    }

    const exerciseIds = parseExerciseIds(
      Object.hasOwn(rawDay, "exerciseIds")
        ? rawDay.exerciseIds
        : Object.hasOwn(rawDay, "exerciseRefs")
          ? rawDay.exerciseRefs
          : rawDay.exercises
    );

    if (exerciseIds.length === 0) {
      throw new AppError(`workoutDays dayIndex ${dayIndex} must include at least one exercise.`, httpStatus.BAD_REQUEST);
    }

    seenDayIndices.add(dayIndex);
    parsedDays.push({ dayIndex, exerciseIds });
  }

  return parsedDays.sort((a, b) => a.dayIndex - b.dayIndex);
};

const extractWorkoutDaysFromProgram = (program) => {
  if (Array.isArray(program?.workoutDays) && program.workoutDays.length > 0) {
    const parsed = program.workoutDays
      .map((day) => ({
        dayIndex: normalizeDayIndex(day?.dayIndex),
        exerciseIds: parseExerciseIds(day?.exerciseRefs || []),
      }))
      .filter((day) => day.dayIndex && day.exerciseIds.length > 0)
      .sort((a, b) => a.dayIndex - b.dayIndex);

    if (parsed.length > 0) {
      return parsed;
    }
  }

  const fallbackExerciseIds = Array.isArray(program?.exerciseRefs)
    ? program.exerciseRefs.map((exerciseRef) => toIdString(exerciseRef)).filter(Boolean)
    : [];

  return distributeExerciseIdsAcrossDays(fallbackExerciseIds);
};

const buildWorkoutDayPayload = (workoutDays, exerciseRefById) =>
  workoutDays.map((day) => ({
    dayIndex: day.dayIndex,
    exerciseRefs: day.exerciseIds.map((exerciseId) => exerciseRefById.get(exerciseId)).filter(Boolean),
  }));

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

const toIdString = (value) => {
  if (!value) return null;

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value._id) {
    return value._id.toString();
  }

  if (typeof value.toString === "function") {
    const asText = value.toString();
    return asText && asText !== "[object Object]" ? asText : null;
  }

  return null;
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

const resolveExerciseExecutionMode = (executionMode, sets) => {
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

const isPopulatedExerciseRef = (exerciseRef) =>
  Boolean(exerciseRef && typeof exerciseRef === "object" && "exerciseName" in exerciseRef);

const mapExerciseFromLibrary = (exercise, index) => {
  const defaultSets = normalizeSetTemplatesForResponse(exercise.defaultSets);
  const primarySet = defaultSets[0] || null;
  const executionMode = resolveExerciseExecutionMode(exercise.executionMode, defaultSets);
  const isCountdown = executionMode === "countdown";

  return {
    id: toIdString(exercise._id),
    exerciseName: exercise.exerciseName,
    name: exercise.exerciseName,
    order: index + 1,
    userType: exercise.userType,
    plan: exercise.userType,
    assignedUser: toAssignedUser(exercise.assignedUser),
    description: exercise.description || "",
    keyBenefits: exercise.keyBenefits || [],
    muscleGroups: exercise.muscleGroups || [],
    exerciseImages: toMediaUrlList(exercise.exerciseImages),
    image: toMediaUrl(exercise.exerciseImages?.[0]),
    targetMuscleImages: toMediaUrlList(exercise.targetMuscleImages),
    targetMuscleImage: toMediaUrl(exercise.targetMuscleImages?.[0]),
    demoVideos: toMediaUrlList(exercise.demoVideos),
    demoVideo: toMediaUrl(exercise.demoVideos?.[0]),
    defaultSets,
    executionMode,
    sets: defaultSets.length,
    reps: primarySet?.reps ?? null,
    countdown: isCountdown,
    weightKg: primarySet?.weightKg ?? 1,
    durationSeconds: isCountdown ? primarySet?.durationSeconds ?? null : null,
    calories: null,
    isVisibleInLibrary: exercise.isVisibleInLibrary,
    status: exercise.status,
    isActive: exercise.isActive,
  };
};

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
  const defaultSets = normalizeSetTemplatesForResponse(exercise.defaultSets);
  const primarySet = defaultSets[0] || null;
  const executionMode = resolveExerciseExecutionMode(exercise.executionMode, defaultSets);
  const isCountdown = executionMode === "countdown";
  const fallbackDuration = exercise.durationSeconds ?? null;

  return {
    id: toIdString(exercise._id),
    exerciseName: exercise.name,
    name: exercise.name,
    order: exercise.order,
    description: exercise.description || "",
    keyBenefits: exercise.keyBenefits || [],
    demoVideos: toMediaUrlList(demoVideos),
    demoVideo: toMediaUrl(demoVideos[0]),
    exerciseImages: toMediaUrlList(exerciseImages),
    image: toMediaUrl(exerciseImages[0]),
    targetMuscleImages: toMediaUrlList(targetMuscleImages),
    targetMuscleImage: toMediaUrl(targetMuscleImages[0]),
    defaultSets,
    executionMode,
    sets: defaultSets.length,
    reps: primarySet?.reps ?? null,
    countdown: isCountdown,
    weightKg: primarySet?.weightKg ?? 1,
    durationSeconds: isCountdown ? primarySet?.durationSeconds ?? fallbackDuration : null,
    calories: exercise.calories ?? null,
  };
};

const buildProgramExercises = (program) => {
  const populatedLibraryExercises =
    Array.isArray(program.exerciseRefs) && program.exerciseRefs.length > 0
      ? program.exerciseRefs.filter(isPopulatedExerciseRef)
      : [];

  if (populatedLibraryExercises.length > 0) {
    return populatedLibraryExercises.map((exercise, index) => mapExerciseFromLibrary(exercise, index));
  }

  return Array.isArray(program.exercises) ? program.exercises.map(mapLegacyExercise) : [];
};

const buildProgramExerciseIds = (program, exercises) => {
  if (Array.isArray(program.exerciseRefs) && program.exerciseRefs.length > 0) {
    return program.exerciseRefs.map((exerciseRef) => toIdString(exerciseRef)).filter(Boolean);
  }

  return Array.isArray(exercises) ? exercises.map((exercise) => toIdString(exercise.id)).filter(Boolean) : [];
};

const buildProgramWorkoutDays = (program, exercises) => {
  const exerciseById = new Map((Array.isArray(exercises) ? exercises : []).map((exercise) => [toIdString(exercise.id), exercise]));
  const workoutDays = extractWorkoutDaysFromProgram(program);

  return workoutDays.map((day) => ({
    dayIndex: day.dayIndex,
    dayLabel: WEEKDAY_LABELS[day.dayIndex] || `Day ${day.dayIndex}`,
    exerciseIds: day.exerciseIds,
    totalExercises: day.exerciseIds.length,
    exercises: day.exerciseIds.map((exerciseId) => exerciseById.get(exerciseId)).filter(Boolean),
  }));
};

const buildProgramSummary = (program) => {
  const exercises = buildProgramExercises(program);
  const workoutDays = buildProgramWorkoutDays(program, exercises);

  return {
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
    totalExercises: exercises.length || program.totalExercises || 0,
    exerciseIds: buildProgramExerciseIds(program, exercises),
    exercises,
    workoutDays,
    status: program.status,
    isActive: program.isActive,
    programImage: toMediaUrl(program.programImages?.[0]),
    programThumbnail: toMediaUrl(program.programThumbnails?.[0]),
    programImages: toMediaUrlList(program.programImages),
    programThumbnails: toMediaUrlList(program.programThumbnails),
    createdAt: program.createdAt,
    updatedAt: program.updatedAt,
  };
};

const buildProgramDetails = (program) => buildProgramSummary(program);

const buildUserExerciseSettingsMap = async (userId, programs) => {
  const exerciseIds = [];

  for (const program of programs || []) {
    if (!program || !Array.isArray(program.exerciseRefs)) continue;

    for (const exerciseRef of program.exerciseRefs) {
      const exerciseId = toIdString(exerciseRef);
      if (exerciseId) {
        exerciseIds.push(exerciseId);
      }
    }
  }

  const uniqueIds = [...new Set(exerciseIds)];
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const userSettings = await UserExerciseSetting.find({
    user: userId,
    exercise: { $in: uniqueIds },
  }).select("exercise customSets");

  return new Map(
    userSettings.map((setting) => [
      setting.exercise.toString(),
      normalizeSetTemplatesForResponse(setting.customSets),
    ])
  );
};

const withEffectiveExerciseSets = (exercise, userSettingsMap) => {
  const exerciseId = toIdString(exercise.id);
  const defaultSets = normalizeSetTemplatesForResponse(exercise.defaultSets);
  const customSets = exerciseId ? userSettingsMap.get(exerciseId) || [] : [];
  const effectiveSets = customSets.length > 0 ? customSets : defaultSets;
  const primarySet = effectiveSets[0] || null;
  const executionMode = resolveExerciseExecutionMode(exercise.executionMode, effectiveSets);
  const isCountdown = executionMode === "countdown";

  return {
    ...exercise,
    executionMode,
    defaultSets,
    customSets,
    effectiveSets,
    hasCustomSettings: customSets.length > 0,
    sets: effectiveSets.length,
    reps: primarySet?.reps ?? null,
    countdown: isCountdown,
    weightKg: primarySet?.weightKg ?? 1,
    durationSeconds: isCountdown ? primarySet?.durationSeconds ?? exercise.durationSeconds ?? null : null,
  };
};

const buildProgramSummaryForUser = (program, userSettingsMap) => {
  const summary = buildProgramSummary(program);
  const enhancedExercises = Array.isArray(summary.exercises)
    ? summary.exercises.map((exercise) => withEffectiveExerciseSets(exercise, userSettingsMap))
    : [];
  const exerciseById = new Map(enhancedExercises.map((exercise) => [toIdString(exercise.id), exercise]));

  return {
    ...summary,
    exercises: enhancedExercises,
    workoutDays: Array.isArray(summary.workoutDays)
      ? summary.workoutDays.map((day) => ({
          ...day,
          exercises: Array.isArray(day.exercises)
            ? day.exercises.map((exercise) => exerciseById.get(toIdString(exercise.id)) || exercise)
            : [],
        }))
      : [],
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

  const workoutDaysInput = getField(parsedBody, ["workoutDays", "programDays", "days"]);
  const rawExerciseSelection = getField(parsedBody, [
    "exerciseIds",
    "exerciseRefs",
    "selectedExerciseIds",
    "selectedExercises",
    "exercises",
  ]).value;

  const providedWorkoutDays = workoutDaysInput.provided ? parseWorkoutDays(workoutDaysInput.value) : [];
  const selectedExerciseIds = parseExerciseIds(rawExerciseSelection);

  let normalizedWorkoutDays =
    providedWorkoutDays.length > 0
      ? providedWorkoutDays
      : distributeExerciseIdsAcrossDays(selectedExerciseIds);

  if (normalizedWorkoutDays.length === 0) {
    throw new AppError("At least one workout day with exercises is required.", httpStatus.BAD_REQUEST);
  }

  const uniqueExerciseIds = [
    ...new Set(normalizedWorkoutDays.flatMap((day) => day.exerciseIds || []).filter(Boolean)),
  ];

  const exerciseRefs = await validateLinkedExercises({
    exerciseIds: uniqueExerciseIds,
    userType,
    assignedUserId: assignedUser,
  });
  const exerciseRefById = new Map(exerciseRefs.map((exerciseRef) => [exerciseRef.toString(), exerciseRef]));
  normalizedWorkoutDays = buildWorkoutDayPayload(normalizedWorkoutDays, exerciseRefById);

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
    workoutDays: normalizedWorkoutDays,
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
    updates.programImages = preserveExistingMediaMetadata(
      normalizeMediaList(imagesInput.value),
      currentProgram.programImages
    );
  }

  const thumbnailsInput = getField(parsedBody, ["programThumbnails", "programThumbnail", "thumbnailImage"]);
  if (thumbnailsInput.provided) {
    updates.programThumbnails = preserveExistingMediaMetadata(
      normalizeMediaList(thumbnailsInput.value),
      currentProgram.programThumbnails
    );
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
  const workoutDaysInput = getField(parsedBody, ["workoutDays", "programDays", "days"]);

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
    exerciseSelectionInput.provided ||
    workoutDaysInput.provided ||
    Object.hasOwn(updates, "userType") ||
    Object.hasOwn(updates, "assignedUser");

  if (shouldValidateLinkedExercises) {
    const nextUserType = updates.userType || currentProgram.userType;
    const nextAssignedUser = Object.hasOwn(updates, "assignedUser")
      ? updates.assignedUser
      : currentProgram.assignedUser?.toString() || null;

    let nextWorkoutDays = workoutDaysInput.provided
      ? parseWorkoutDays(workoutDaysInput.value)
      : extractWorkoutDaysFromProgram(currentProgram);

    if (!workoutDaysInput.provided && exerciseSelectionInput.provided) {
      const selectedExerciseIds = parseExerciseIds(exerciseSelectionInput.value);
      nextWorkoutDays = distributeExerciseIdsAcrossDays(selectedExerciseIds);
    }

    if (workoutDaysInput.provided && nextWorkoutDays.length === 0 && exerciseSelectionInput.provided) {
      const selectedExerciseIds = parseExerciseIds(exerciseSelectionInput.value);
      nextWorkoutDays = distributeExerciseIdsAcrossDays(selectedExerciseIds);
    }

    if (nextWorkoutDays.length === 0) {
      throw new AppError("At least one workout day with exercises is required.", httpStatus.BAD_REQUEST);
    }

    const nextExerciseIds = [
      ...new Set(nextWorkoutDays.flatMap((day) => day.exerciseIds || []).filter(Boolean)),
    ];

    const validatedRefs = await validateLinkedExercises({
      exerciseIds: nextExerciseIds,
      userType: nextUserType,
      assignedUserId: nextAssignedUser,
    });
    const exerciseRefById = new Map(validatedRefs.map((exerciseRef) => [exerciseRef.toString(), exerciseRef]));

    updates.exerciseRefs = validatedRefs;
    updates.workoutDays = buildWorkoutDayPayload(nextWorkoutDays, exerciseRefById);
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
    ...buildUserAccessibleFilter(user),
    $and: [{ $or: interestConditions }],
  };
};

const populateProgramQuery = (query) =>
  query
    .populate("assignedUser", "firstName email")
    .populate({
      path: "exerciseRefs",
      select: "exerciseName userType assignedUser description keyBenefits muscleGroups exerciseImages targetMuscleImages demoVideos defaultSets executionMode isVisibleInLibrary status isActive",
      populate: {
        path: "assignedUser",
        select: "firstName email",
      },
    })
    .populate({
      path: "workoutDays.exerciseRefs",
      select: "exerciseName userType assignedUser description keyBenefits muscleGroups exerciseImages targetMuscleImages demoVideos defaultSets executionMode isVisibleInLibrary status isActive",
      populate: {
        path: "assignedUser",
        select: "firstName email",
      },
    });

const getProgramBodyFromRequest = async (req) => {
  let payload = mergeUploadedMediaIntoBody(req.body, req.files, [
    { target: "programImages", fieldNames: PROGRAM_IMAGE_FIELDS },
    { target: "programThumbnails", fieldNames: PROGRAM_THUMBNAIL_FIELDS },
  ]);

  const imageFiles = getUploadedFilesByFieldNames(req.files, PROGRAM_IMAGE_FIELDS);
  const thumbnailFiles = getUploadedFilesByFieldNames(req.files, PROGRAM_THUMBNAIL_FIELDS);

  if (imageFiles.length > 0) {
    payload = {
      ...(payload || {}),
      programImages: await uploadImagesToCloudinary(
        imageFiles,
        CLOUDINARY_PROGRAM_IMAGE_FOLDER,
        "Failed to upload program images to Cloudinary."
      ),
    };
  }

  if (thumbnailFiles.length > 0) {
    payload = {
      ...(payload || {}),
      programThumbnails: await uploadImagesToCloudinary(
        thumbnailFiles,
        CLOUDINARY_PROGRAM_THUMBNAIL_FOLDER,
        "Failed to upload program thumbnails to Cloudinary."
      ),
    };
  }

  return payload;
};

export const createProgram = catchAsync(async (req, res) => {
  const payload = await buildCreatePayload(await getProgramBodyFromRequest(req));

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
    populateProgramQuery(
      Program.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
    ),
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

  const previousProgramImages = normalizeMediaList(program.programImages);
  const previousProgramThumbnails = normalizeMediaList(program.programThumbnails);

  const updates = await buildUpdatePayload(await getProgramBodyFromRequest(req), program);
  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields were provided for update.", httpStatus.BAD_REQUEST);
  }

  Object.assign(program, updates, { updatedBy: req.user._id });
  await program.save();

  const removedPublicIds = [
    ...resolveRemovedCloudinaryPublicIds(previousProgramImages, program.programImages),
    ...resolveRemovedCloudinaryPublicIds(previousProgramThumbnails, program.programThumbnails),
  ];
  await deleteCloudinaryAssetsByPublicIds(removedPublicIds);

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

  const programAssets = [
    ...normalizeMediaList(program.programImages),
    ...normalizeMediaList(program.programThumbnails),
  ];
  const programAssetPublicIds = [...new Set(programAssets.map((asset) => getMediaAssetPublicId(asset)).filter(Boolean))];

  await Promise.all([
    Program.deleteOne({ _id: program._id }),
    UserProgram.deleteMany({ program: program._id }),
  ]);
  await deleteCloudinaryAssetsByPublicIds(programAssetPublicIds);

  res.status(httpStatus.OK).json({
    success: true,
    message: "Program deleted successfully.",
  });
});

export const listPremiumUsers = catchAsync(async (req, res) => {
  const search = asString(req.query.search);

  const query = {
    role: "user",
    isActive: true,
    selectedPlan: { $in: PREMIUM_PLAN_KEYS },
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
    populateProgramQuery(Program.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)),
    Program.countDocuments(filter),
  ]);
  const userSettingsMap = await buildUserExerciseSettingsMap(req.user._id, programs);

  res.status(httpStatus.OK).json({
    success: true,
    data: programs.map((program) => buildProgramSummaryForUser(program, userSettingsMap)),
    meta: buildPagination(page, limit, total),
  });
});

export const getMyPrograms = catchAsync(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;
  const trackedProgramIds = await collectTrackedProgramIdsForUser(req.user._id);
  const filter = buildMyProgramsFilter(req.user, trackedProgramIds);

  if (!filter) {
    return res.status(httpStatus.OK).json({
      success: true,
      data: [],
      meta: buildPagination(page, limit, 0),
    });
  }

  if (req.query.search) {
    const pattern = new RegExp(escapeRegex(asString(req.query.search)), "i");
    filter.$and = [...(filter.$and || []), { $or: [{ programName: pattern }, { programDescription: pattern }] }];
  }

  const [programs, total] = await Promise.all([
    populateProgramQuery(Program.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)),
    Program.countDocuments(filter),
  ]);
  const userSettingsMap = await buildUserExerciseSettingsMap(req.user._id, programs);

  res.status(httpStatus.OK).json({
    success: true,
    data: programs.map((program) => buildProgramSummaryForUser(program, userSettingsMap)),
    meta: buildPagination(page, limit, total),
  });
});

export const startProgramForUser = catchAsync(async (req, res) => {
  const { programId } = req.params;

  if (!mongoose.isValidObjectId(programId)) {
    throw new AppError("Invalid program id.", httpStatus.BAD_REQUEST);
  }

  const program = await populateProgramQuery(
    Program.findOne({
      _id: programId,
      ...buildUserAccessibleFilter(req.user),
    })
  );

  if (!program) {
    throw new AppError("Program not found or not accessible.", httpStatus.NOT_FOUND);
  }

  await touchUserProgram({
    userId: req.user._id,
    programId: program._id,
  });

  const userSettingsMap = await buildUserExerciseSettingsMap(req.user._id, [program]);

  res.status(httpStatus.OK).json({
    success: true,
    message: "Program added to your programs.",
    data: buildProgramSummaryForUser(program, userSettingsMap),
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

  const userSettingsMap = await buildUserExerciseSettingsMap(req.user._id, [program]);

  return res.status(httpStatus.OK).json({
    success: true,
    data: buildProgramSummaryForUser(program, userSettingsMap),
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
    populateProgramQuery(Program.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)),
    Program.countDocuments(filter),
  ]);
  const userSettingsMap = await buildUserExerciseSettingsMap(req.user._id, programs);

  res.status(httpStatus.OK).json({
    success: true,
    data: programs.map((program) => buildProgramSummaryForUser(program, userSettingsMap)),
    meta: buildPagination(page, limit, total),
  });
});
