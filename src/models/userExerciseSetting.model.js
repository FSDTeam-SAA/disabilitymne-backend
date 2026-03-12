import mongoose from "mongoose";

const userExerciseSetSchema = new mongoose.Schema(
  {
    setNumber: { type: Number, min: 1, required: true },
    reps: { type: Number, min: 0 },
    durationSeconds: { type: Number, min: 0 },
    weightKg: { type: Number, min: 0, default: 1 },
  },
  { _id: false }
);

const userExerciseSettingSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    exercise: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Exercise",
      required: true,
      index: true,
    },
    customSets: {
      type: [userExerciseSetSchema],
      default: [],
    },
  },
  { timestamps: true }
);

userExerciseSettingSchema.index({ user: 1, exercise: 1 }, { unique: true });

export const UserExerciseSetting = mongoose.model("UserExerciseSetting", userExerciseSettingSchema);
