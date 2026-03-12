import mongoose from "mongoose";

export const WORKOUT_EXPERIENCE_LEVELS = ["easy", "intermediate", "very_hard"];

const workoutExperienceSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    program: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Program",
      required: true,
      index: true,
    },
    experienceLevel: {
      type: String,
      enum: WORKOUT_EXPERIENCE_LEVELS,
      required: true,
      index: true,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
      maxlength: [500, "Experience note should not exceed 500 characters"],
    },
    completedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

workoutExperienceSchema.index({ user: 1, createdAt: -1 });
workoutExperienceSchema.index({ program: 1, createdAt: -1 });

export const WorkoutExperience = mongoose.model("WorkoutExperience", workoutExperienceSchema);
