import { toMediaUrl } from "./mediaResponse.js";
import { deriveSubscriptionStatus } from "../services/subscriptionSync.service.js";

export const serializeUser = (user) => ({
  id: user._id,
  role: user.role || "user",
  firstName: user.firstName,
  lastName: user.lastName || "",
  email: user.email,
  phone: user.phone,
  bio: user.bio || "",
  preferredLanguage: user.preferredLanguage || "en",
  accessibilityPreferences: {
    largerText: Boolean(user.accessibilityPreferences?.largerText),
    highContrast: Boolean(user.accessibilityPreferences?.highContrast),
    reducedMotion: Boolean(user.accessibilityPreferences?.reducedMotion),
    screenReaderOptimized: Boolean(user.accessibilityPreferences?.screenReaderOptimized),
  },
  profileImage: toMediaUrl(user.profileImage),
  gender: user.gender || null,
  age: user.age ?? null,
  weightCurrent: user.weightCurrent || null,
  goalWeight: user.goalWeight || null,
  height: user.height || null,
  activityLevel: user.activityLevel || "moderately_active",
  fitnessGoals: user.fitnessGoals || [],
  mobilityType: user.mobilityType || null,
  mobilityTypeOther: user.mobilityTypeOther || null,
  fitnessExperience: user.fitnessExperience || null,
  onboardingStep: user.onboardingStep,
  onboardingCompleted: user.onboardingCompleted,
  selectedPlan: user.selectedPlan || null,
  subscriptionStatus: deriveSubscriptionStatus(user),
  trialActivatedAt: user.trialActivatedAt || null,
  trialEndsAt: user.trialEndsAt || null,
  subscriptionStartedAt: user.subscriptionStartedAt || null,
  subscriptionEndsAt: user.subscriptionEndsAt || null,
  adaptiveNutrition: user.adaptiveNutrition
    ? {
        goal: user.adaptiveNutrition.goal || "maintenance",
        currentDailyCalories: Number(user.adaptiveNutrition.currentDailyCalories || 0),
        startedAt: user.adaptiveNutrition.startedAt || null,
        lastAdjustedAt: user.adaptiveNutrition.lastAdjustedAt || null,
        lastAdjustmentDeltaKcal: Number(user.adaptiveNutrition.lastAdjustmentDeltaKcal || 0),
        lastCurrentWeekAvgKg:
          user.adaptiveNutrition.lastCurrentWeekAvgKg === null ||
          user.adaptiveNutrition.lastCurrentWeekAvgKg === undefined
            ? null
            : Number(user.adaptiveNutrition.lastCurrentWeekAvgKg),
        lastPreviousWeekAvgKg:
          user.adaptiveNutrition.lastPreviousWeekAvgKg === null ||
          user.adaptiveNutrition.lastPreviousWeekAvgKg === undefined
            ? null
            : Number(user.adaptiveNutrition.lastPreviousWeekAvgKg),
        lastWeeklyChangePercent:
          user.adaptiveNutrition.lastWeeklyChangePercent === null ||
          user.adaptiveNutrition.lastWeeklyChangePercent === undefined
            ? null
            : Number(user.adaptiveNutrition.lastWeeklyChangePercent),
      }
    : null,
  isSponsored: Boolean(user.isSponsored),
  sponsorship: user.sponsorship
    ? {
        note: user.sponsorship.note || "",
        grantedBy: user.sponsorship.grantedBy || null,
        grantedAt: user.sponsorship.grantedAt || null,
      }
    : null,
  lastLoginAt: user.lastLoginAt || null,
  accountStatus: user.accountStatus || (user.isActive ? "active" : "deactivated"),
  isActive: Boolean(user.isActive),
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
}); 
