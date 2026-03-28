import mongoose from "mongoose";

const workoutSessionTotalsSchema = new mongoose.Schema(
  {
    scheduledExercises: { type: Number, default: 0, min: 0 },
    completedExercises: { type: Number, default: 0, min: 0 },
    durationMinutes: { type: Number, default: 0, min: 0 },
    caloriesBurned: { type: Number, default: 0, min: 0 },
    trainingVolume: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const workoutSessionSchema = new mongoose.Schema(
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
    dayIndex: {
      type: Number,
      required: true,
      min: 1,
      max: 7,
      index: true,
    },
    weekStartDate: {
      type: Date,
      required: true,
      index: true,
    },
    scheduledExercises: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Exercise",
        },
      ],
      default: [],
    },
    completedExercises: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Exercise",
        },
      ],
      default: [],
    },
    status: {
      type: String,
      enum: ["in_progress", "completed"],
      default: "in_progress",
      index: true,
    },
    completedAt: {
      type: Date,
      default: null,
      index: true,
    },
    totals: {
      type: workoutSessionTotalsSchema,
      default: () => ({}),
    },
  },
  { timestamps: true }
);

workoutSessionSchema.index({ user: 1, program: 1, weekStartDate: 1, dayIndex: 1 }, { unique: true });
workoutSessionSchema.index({ user: 1, completedAt: -1 });
workoutSessionSchema.index({ program: 1, completedAt: -1 });

export const WorkoutSession = mongoose.model("WorkoutSession", workoutSessionSchema);
