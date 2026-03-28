import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { PLAN_ENUM_KEYS } from "../constants/subscriptionPlans.js";

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

const accessibilityPreferencesSchema = new mongoose.Schema(
  {
    largerText: { type: Boolean, default: false },
    highContrast: { type: Boolean, default: false },
    reducedMotion: { type: Boolean, default: false },
    screenReaderOptimized: { type: Boolean, default: false },
  },
  { _id: false }
);

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

const favoriteRecipeRefSchema = new mongoose.Schema(
  {
    recipe: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Recipe",
      required: true,
    },
    savedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const favoriteMealItemSchema = new mongoose.Schema(
  {
    foodName: {
      type: String,
      required: true,
      trim: true,
      maxlength: [160, "Food name should not exceed 160 characters"],
    },
    brandName: {
      type: String,
      default: "",
      trim: true,
      maxlength: [120, "Brand name should not exceed 120 characters"],
    },
    source: {
      type: String,
      enum: ["manual", "usda"],
      default: "manual",
    },
    fdcId: {
      type: Number,
      default: null,
      min: 1,
    },
    quantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    servingLabel: {
      type: String,
      default: "gram",
      trim: true,
      maxlength: [60, "Serving label should not exceed 60 characters"],
    },
    totalGrams: {
      type: Number,
      default: 0,
      min: 0,
    },
    caloriesKcal: {
      type: Number,
      default: 0,
      min: 0,
    },
    proteinG: {
      type: Number,
      default: 0,
      min: 0,
    },
    carbsG: {
      type: Number,
      default: 0,
      min: 0,
    },
    fatG: {
      type: Number,
      default: 0,
      min: 0,
    },
    fiberG: {
      type: Number,
      default: 0,
      min: 0,
    },
    sugarG: {
      type: Number,
      default: 0,
      min: 0,
    },
    imageUrl: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { _id: false }
);

const favoriteMealSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: [160, "Favorite meal title should not exceed 160 characters"],
    },
    mealType: {
      type: String,
      enum: ["breakfast", "lunch", "dinner", "snack", "other"],
      required: true,
    },
    signature: {
      type: String,
      required: true,
      trim: true,
      maxlength: [600, "Favorite meal signature should not exceed 600 characters"],
    },
    sourceDate: {
      type: Date,
      default: null,
    },
    itemCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    items: {
      type: [favoriteMealItemSchema],
      default: [],
    },
    totalGrams: {
      type: Number,
      default: 0,
      min: 0,
    },
    caloriesKcal: {
      type: Number,
      default: 0,
      min: 0,
    },
    proteinG: {
      type: Number,
      default: 0,
      min: 0,
    },
    carbsG: {
      type: Number,
      default: 0,
      min: 0,
    },
    fatG: {
      type: Number,
      default: 0,
      min: 0,
    },
    fiberG: {
      type: Number,
      default: 0,
      min: 0,
    },
    sugarG: {
      type: Number,
      default: 0,
      min: 0,
    },
    imageUrl: {
      type: String,
      default: "",
      trim: true,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
      maxlength: [500, "Favorite meal notes should not exceed 500 characters"],
    },
    savedAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const mediaAssetSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true },
    publicId: { type: String, default: "", trim: true },
    mimetype: { type: String, default: "", trim: true },
    size: { type: Number, default: 0, min: 0 },
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
    lastName: {
      type: String,
      default: "",
      trim: true,
      maxlength: [80, "Last name should not exceed 80 characters"],
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
    bio: {
      type: String,
      default: "",
      trim: true,
      maxlength: [1000, "Bio should not exceed 1000 characters"],
    },
    preferredLanguage: {
      type: String,
      enum: ["en", "sr"],
      default: "en",
    },
    accessibilityPreferences: {
      type: accessibilityPreferencesSchema,
      default: () => ({
        largerText: false,
        highContrast: false,
        reducedMotion: false,
        screenReaderOptimized: false,
      }),
    },
    profileImage: {
      type: mediaAssetSchema,
      default: null,
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
    favoriteRecipeRefs: {
      type: [favoriteRecipeRefSchema],
      default: [],
    },
    favoriteMeals: {
      type: [favoriteMealSchema],
      default: [],
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
      enum: PLAN_ENUM_KEYS,
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
    refreshTokenHash: {
      type: String,
      default: null,
      select: false,
    },
    refreshTokenExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },
    passwordChangedAt: Date,
    lastLoginAt: Date,
    accountStatus: {
      type: String,
      enum: ["active", "deactivated", "suspended"],
      default: "active",
      index: true,
    },
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

userSchema.methods.setRefreshToken = function setRefreshToken(refreshToken, ttlMs) {
  const hash = crypto.createHash("sha256").update(String(refreshToken)).digest("hex");
  this.refreshTokenHash = hash;
  this.refreshTokenExpiresAt = new Date(Date.now() + ttlMs);
};

userSchema.methods.isRefreshTokenValid = function isRefreshTokenValid(refreshToken) {
  if (!this.refreshTokenHash || !this.refreshTokenExpiresAt) {
    return false;
  }

  if (this.refreshTokenExpiresAt.getTime() < Date.now()) {
    return false;
  }

  const hash = crypto.createHash("sha256").update(String(refreshToken)).digest("hex");
  return hash === this.refreshTokenHash;
};

userSchema.methods.clearRefreshToken = function clearRefreshToken() {
  this.refreshTokenHash = null;
  this.refreshTokenExpiresAt = null;
};

export const User = mongoose.model("User", userSchema);
