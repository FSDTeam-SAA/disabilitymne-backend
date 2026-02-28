import mongoose from "mongoose";

const LEVELS = ["beginner", "intermediate", "advanced"];
const USER_TYPES = ["normal_user", "premium_user"];

const mediaAssetSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true },
    publicId: { type: String, default: "", trim: true },
    mimetype: { type: String, default: "", trim: true },
    size: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const setTemplateSchema = new mongoose.Schema(
  {
    setNumber: { type: Number, min: 1, required: true },
    reps: { type: Number, min: 0 },
    weightKg: { type: Number, min: 0 },
    durationSeconds: { type: Number, min: 0 },
  },
  { _id: false }
);

const exerciseSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: [120, "Exercise name should not exceed 120 characters"],
    },
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: [1200, "Exercise description should not exceed 1200 characters"],
    },
    order: { type: Number, min: 1, required: true },
    keyBenefits: {
      type: [String],
      default: [],
    },
    demoVideo: {
      type: mediaAssetSchema,
      default: null,
    },
    demoVideos: {
      type: [mediaAssetSchema],
      default: [],
    },
    image: {
      type: mediaAssetSchema,
      default: null,
    },
    exerciseImages: {
      type: [mediaAssetSchema],
      default: [],
    },
    targetMuscleImages: {
      type: [mediaAssetSchema],
      default: [],
    },
    defaultSets: {
      type: [setTemplateSchema],
      default: [],
    },
    durationSeconds: { type: Number, min: 0 },
    calories: { type: Number, min: 0 },
  },
  { _id: false }
);

const programSchema = new mongoose.Schema(
  {
    programName: {
      type: String,
      required: [true, "Program name is required"],
      trim: true,
      maxlength: [120, "Program name should not exceed 120 characters"],
    },
    programDuration: {
      type: String,
      required: [true, "Program duration is required"],
      trim: true,
      maxlength: [60, "Program duration should not exceed 60 characters"],
    },
    durationMinutes: {
      type: Number,
      required: [true, "durationMinutes is required"],
      min: [1, "durationMinutes must be at least 1 minute"],
      max: [480, "durationMinutes should not exceed 480 minutes"],
    },
    programLevel: {
      type: String,
      enum: LEVELS,
      required: [true, "Program level is required"],
      default: "beginner",
    },
    userType: {
      type: String,
      enum: USER_TYPES,
      required: [true, "userType is required"],
      default: "normal_user",
      index: true,
    },
    assignedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    programDescription: {
      type: String,
      default: "",
      trim: true,
      maxlength: [4000, "Program description should not exceed 4000 characters"],
    },
    safetyNote: {
      type: String,
      default: "",
      trim: true,
      maxlength: [500, "Safety note should not exceed 500 characters"],
    },
    mobilityType: {
      type: String,
      default: "",
      trim: true,
      maxlength: [80, "Mobility type should not exceed 80 characters"],
      index: true,
    },
    weekCount: {
      type: Number,
      min: 1,
      max: 104,
      default: 12,
    },
    programImages: {
      type: [mediaAssetSchema],
      default: [],
    },
    programThumbnails: {
      type: [mediaAssetSchema],
      default: [],
    },
    exerciseRefs: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Exercise",
        },
      ],
      default: [],
    },
    exercises: {
      type: [exerciseSchema],
      default: [],
    },
    totalExercises: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ["draft", "published", "archived"],
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

programSchema.pre("validate", function preValidate(next) {
  this.exerciseRefs = Array.isArray(this.exerciseRefs) ? this.exerciseRefs.filter(Boolean) : [];
  this.totalExercises = this.exerciseRefs.length;

  if (this.totalExercises === 0) {
    this.totalExercises = Array.isArray(this.exercises) ? this.exercises.length : 0;
  }

  if (Array.isArray(this.exercises)) {
    this.exercises.forEach((exercise) => {
      if (typeof exercise.keyBenefits === "string") {
        exercise.keyBenefits = exercise.keyBenefits
          .split(/\r?\n|,/)
          .map((item) => String(item).trim().replace(/^[-\u2022*\u00B7]+\s*/, ""))
          .filter(Boolean);
      } else if (!Array.isArray(exercise.keyBenefits)) {
        exercise.keyBenefits = [];
      }

      const demoVideos = Array.isArray(exercise.demoVideos) ? exercise.demoVideos.filter(Boolean) : [];
      if (demoVideos.length === 0 && exercise.demoVideo) {
        demoVideos.push(exercise.demoVideo);
      }
      exercise.demoVideos = demoVideos;
      exercise.demoVideo = demoVideos[0] || null;

      const exerciseImages = Array.isArray(exercise.exerciseImages) ? exercise.exerciseImages.filter(Boolean) : [];
      if (exerciseImages.length === 0 && exercise.image) {
        exerciseImages.push(exercise.image);
      }
      exercise.exerciseImages = exerciseImages;
      exercise.image = exerciseImages[0] || null;

      if (!Array.isArray(exercise.targetMuscleImages)) {
        exercise.targetMuscleImages = [];
      }
    });
  }

  if (this.userType === "normal_user") {
    this.assignedUser = null;
  }

  if (this.userType === "premium_user" && !this.assignedUser) {
    return next(new Error("assignedUser is required for premium_user programs."));
  }

  next();
});

programSchema.index({ status: 1, isActive: 1, userType: 1, createdAt: -1 });
programSchema.index({ assignedUser: 1, status: 1, isActive: 1, createdAt: -1 });
programSchema.index({ exerciseRefs: 1, status: 1, isActive: 1 });

export const Program = mongoose.model("Program", programSchema);
