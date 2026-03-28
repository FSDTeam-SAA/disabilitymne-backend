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
    exercise: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Exercise",
      default: null,
      index: true,
    },
    dayIndex: {
      type: Number,
      min: 1,
      max: 7,
      default: null,
      index: true,
    },
    weekStartDate: {
      type: Date,
      default: null,
      index: true,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkoutSession",
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
    trainingVolume: {
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
workoutLogSchema.index({ user: 1, program: 1, weekStartDate: -1, dayIndex: 1 });
workoutLogSchema.index({ user: 1, exercise: 1, completedAt: -1 });
workoutLogSchema.index({ sessionId: 1, completedAt: -1 });

workoutLogSchema.pre("validate", function preValidate(next) {
  const sets = Array.isArray(this.sets) ? this.sets : [];
  const trainingVolume = sets.reduce((sum, set) => {
    const reps = Number(set?.reps);
    const weightKg = Number(set?.weightKg);
    if (!Number.isFinite(reps) || reps <= 0 || !Number.isFinite(weightKg) || weightKg <= 0) {
      return sum;
    }
    return sum + (reps * weightKg);
  }, 0);

  this.trainingVolume = Number.isFinite(trainingVolume) && trainingVolume > 0 ? Number(trainingVolume.toFixed(2)) : 0;
  next();
});

export const WorkoutLog = mongoose.model("WorkoutLog", workoutLogSchema);
