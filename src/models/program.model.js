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
    demoVideo: {
      type: mediaAssetSchema,
      default: null,
    },
    image: {
      type: mediaAssetSchema,
      default: null,
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
  this.totalExercises = Array.isArray(this.exercises) ? this.exercises.length : 0;

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

export const Program = mongoose.model("Program", programSchema);
