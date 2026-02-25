import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { PLAN_KEYS } from "../constants/subscriptionPlans.js";

const WEIGHT_UNITS = ["kg", "lbs"];
const HEIGHT_UNITS = ["cm", "ft"];
const FITNESS_GOALS = ["build_muscle", "lose_weight", "manage_weight", "boost_energy", "flexibility", "general_wellness"];
const MOBILITY_TYPES = [
  "wheelchair_user",
  "limited_mobility",
  "amputee_leg",
  "amputee_arm",
  "neurological_condition",
  "chronic_pain",
  "visual_impairment",
  "other",
];
const FITNESS_EXPERIENCE_LEVELS = ["beginner", "intermediate", "advanced"];

const weightMeasurementSchema = new mongoose.Schema(
  {
    value: { type: Number, min: 0 },
    unit: { type: String, required: true, enum: WEIGHT_UNITS },
  },
  { _id: false }
);

const heightMeasurementSchema = new mongoose.Schema(
  {
    value: { type: Number, min: 0 },
    unit: { type: String, required: true, enum: HEIGHT_UNITS },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
      index: true,
    },
    firstName: {
      type: String,
      required: [true, "First name is required"],
      trim: true,
      maxlength: [80, "First name should not exceed 80 characters"],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      default: "",
      trim: true,
      maxlength: [40, "Phone number should not exceed 40 characters"],
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [8, "Password must be at least 8 characters"],
      select: false,
    },

    gender: {
      type: String,
      enum: ["male", "female", "other", "prefer_not_to_say"],
    },
    age: {
      type: Number,
      min: [13, "Age must be at least 13"],
      max: [120, "Age should be 120 or below"],
    },
    weightCurrent: {
      type: weightMeasurementSchema,
      default: null,
    },
    goalWeight: {
      type: weightMeasurementSchema,
      default: null,
    },
    height: {
      type: heightMeasurementSchema,
      default: null,
    },
    fitnessGoals: [
      {
        type: String,
        enum: FITNESS_GOALS,
      },
    ],
    mobilityType: {
      type: String,
      enum: MOBILITY_TYPES,
    },
    mobilityTypeOther: {
      type: String,
      trim: true,
      maxlength: [120, "Mobility type details should not exceed 120 characters"],
    },
    fitnessExperience: {
      type: String,
      enum: FITNESS_EXPERIENCE_LEVELS,
    },
    onboardingStep: {
      type: Number,
      default: 0,
      min: 0,
      max: 8,
    },
    onboardingCompleted: {
      type: Boolean,
      default: false,
    },

    selectedPlan: {
      type: String,
      enum: PLAN_KEYS,
    },
    subscriptionStatus: {
      type: String,
      enum: ["none", "trial", "pending_payment", "active", "expired", "cancelled"],
      default: "none",
    },
    trialActivatedAt: Date,
    trialEndsAt: Date,
    subscriptionStartedAt: Date,
    subscriptionEndsAt: Date,

    passwordResetOtpHash: {
      type: String,
      default: null,
      select: false,
    },
    passwordResetOtpExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },
    passwordChangedAt: Date,
    lastLoginAt: Date,
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

userSchema.pre("save", async function preSave(next) {
  if (!this.isModified("password")) {
    return next();
  }

  this.password = await bcrypt.hash(this.password, 12);

  if (!this.isNew) {
    this.passwordChangedAt = new Date();
  }

  next();
});

userSchema.methods.comparePassword = function comparePassword(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.setPasswordResetOtp = function setPasswordResetOtp(otp, ttlMinutes = 10) {
  const hash = crypto.createHash("sha256").update(String(otp)).digest("hex");
  this.passwordResetOtpHash = hash;
  this.passwordResetOtpExpiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
};

userSchema.methods.isPasswordResetOtpValid = function isPasswordResetOtpValid(otp) {
  if (!this.passwordResetOtpHash || !this.passwordResetOtpExpiresAt) {
    return false;
  }

  if (this.passwordResetOtpExpiresAt.getTime() < Date.now()) {
    return false;
  }

  const hash = crypto.createHash("sha256").update(String(otp)).digest("hex");
  return hash === this.passwordResetOtpHash;
};

userSchema.methods.clearPasswordResetOtp = function clearPasswordResetOtp() {
  this.passwordResetOtpHash = null;
  this.passwordResetOtpExpiresAt = null;
};

export const User = mongoose.model("User", userSchema);
