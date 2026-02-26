import mongoose from "mongoose";

const workoutSetSchema = new mongoose.Schema(
  {
    setNumber: { type: Number, min: 1, required: true },
    reps: { type: Number, min: 0 },
    weightKg: { type: Number, min: 0 },
    durationSeconds: { type: Number, min: 0 },
  },
  { _id: false }
);

const workoutLogSchema = new mongoose.Schema(
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
      default: null,
      index: true,
    },
    exerciseName: {
      type: String,
      default: "",
      trim: true,
      maxlength: [120, "exerciseName should not exceed 120 characters"],
    },
    sets: {
      type: [workoutSetSchema],
      default: [],
    },
    caloriesBurned: {
      type: Number,
      default: 0,
      min: 0,
    },
    durationMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },
    completedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
      maxlength: [500, "Workout notes should not exceed 500 characters"],
    },
  },
  { timestamps: true }
);

workoutLogSchema.index({ user: 1, completedAt: -1 });

export const WorkoutLog = mongoose.model("WorkoutLog", workoutLogSchema);
