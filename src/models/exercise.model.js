import mongoose from "mongoose";

export const EXERCISE_USER_TYPES = ["all_user", "premium_user"];
export const EXERCISE_STATUSES = ["draft", "published", "archived"];
export const EXERCISE_EXECUTION_MODES = ["set_reps", "countdown"];

const mediaAssetSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true },
    publicId: { type: String, default: "", trim: true },
    mimetype: { type: String, default: "", trim: true },
    size: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const defaultSetSchema = new mongoose.Schema(
  {
    setNumber: { type: Number, min: 1, required: true },
    reps: { type: Number, min: 0 },
    durationSeconds: { type: Number, min: 0 },
    weightKg: { type: Number, min: 0, default: 1 },
    restSeconds: { type: Number, min: 0 },
    notes: {
      type: String,
      default: "",
      trim: true,
      maxlength: [500, "Set notes should not exceed 500 characters"],
    },
  },
  { _id: false }
);

const normalizeStringArray = (input) => {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .map((item) => item.replace(/^[-\u2022*\u00B7]+\s*/, ""))
    .filter(Boolean);
};

const exerciseSchema = new mongoose.Schema(
  {
    exerciseName: {
      type: String,
      required: [true, "Exercise name is required"],
      trim: true,
      maxlength: [120, "Exercise name should not exceed 120 characters"],
    },
    userType: {
      type: String,
      enum: EXERCISE_USER_TYPES,
      required: [true, "userType is required"],
      default: "all_user",
      index: true,
    },
    assignedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: [4000, "Exercise description should not exceed 4000 characters"],
    },
    keyBenefits: {
      type: [String],
      default: [],
    },
    muscleGroups: {
      type: [String],
      default: [],
    },
    exerciseImages: {
      type: [mediaAssetSchema],
      default: [],
    },
    targetMuscleImages: {
      type: [mediaAssetSchema],
      default: [],
    },
    demoVideos: {
      type: [mediaAssetSchema],
      default: [],
    },
    defaultSets: {
      type: [defaultSetSchema],
      default: [],
    },
    executionMode: {
      type: String,
      enum: EXERCISE_EXECUTION_MODES,
      default: "set_reps",
      index: true,
    },
    isVisibleInLibrary: {
      type: Boolean,
      default: true,
      index: true,
    },
    status: {
      type: String,
      enum: EXERCISE_STATUSES,
      default: "published",
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

exerciseSchema.pre("validate", function preValidate(next) {
  this.keyBenefits = normalizeStringArray(this.keyBenefits);
  this.muscleGroups = normalizeStringArray(this.muscleGroups);
  this.exerciseImages = Array.isArray(this.exerciseImages) ? this.exerciseImages.filter(Boolean) : [];
  this.targetMuscleImages = Array.isArray(this.targetMuscleImages) ? this.targetMuscleImages.filter(Boolean) : [];
  this.demoVideos = Array.isArray(this.demoVideos) ? this.demoVideos.filter(Boolean) : [];
  this.defaultSets = Array.isArray(this.defaultSets)
    ? this.defaultSets
      .filter((set) => set && typeof set === "object")
      .map((set, index) => {
        const parsedSetNumber = Number(set.setNumber);
        const parsedWeight = Number(set.weightKg);

        return {
          ...set,
          setNumber: Number.isFinite(parsedSetNumber) && parsedSetNumber >= 1 ? Math.floor(parsedSetNumber) : index + 1,
          weightKg: Number.isFinite(parsedWeight) && parsedWeight >= 0 ? parsedWeight : 1,
        };
      })
    : [];

  if (!this.executionMode) {
    const hasDuration = this.defaultSets.some((set) => set.durationSeconds !== undefined && set.durationSeconds !== null);
    this.executionMode = hasDuration ? "countdown" : "set_reps";
  }

  if (this.userType === "all_user") {
    this.assignedUser = null;
  }

  if (this.userType === "premium_user" && !this.assignedUser) {
    return next(new Error("assignedUser is required for premium_user exercises."));
  }

  if (this.exerciseImages.length === 0) {
    return next(new Error("At least one exercise image is required."));
  }

  if (this.demoVideos.length === 0) {
    return next(new Error("At least one exercise demo video is required."));
  }

  next();
});

exerciseSchema.index({ status: 1, isActive: 1, userType: 1, isVisibleInLibrary: 1, createdAt: -1 });
exerciseSchema.index({ assignedUser: 1, status: 1, isActive: 1, createdAt: -1 });
exerciseSchema.index({ exerciseName: "text", description: "text" });

export const Exercise = mongoose.model("Exercise", exerciseSchema);
