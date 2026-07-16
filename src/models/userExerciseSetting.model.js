import mongoose from "mongoose";

const userExerciseSetSchema = new mongoose.Schema(
  {
    setNumber: { type: Number, min: 1, required: true },
    reps: { type: Number, min: 0 },
    durationSeconds: { type: Number, min: 0 },
    weightKg: { type: Number, min: 0, default: 1 },
    restSeconds: { type: Number, min: 0 },
    notes: {
      type: String,
      default: "",
      trim: true,
      maxlength: [500, "Set notes should not exceed 500 characters"],
    },
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
    /** Admin-controlled defaults for this user+exercise assignment */
    customSets: {
      type: [userExerciseSetSchema],
      default: [],
    },
    restSeconds: { type: Number, min: 0 },
    notes: {
      type: String,
      default: "",
      trim: true,
      maxlength: [1000, "Exercise notes should not exceed 1000 characters"],
    },
    /** Weight is user-editable; admin sets sets/reps/order/rest/notes */
    order: { type: Number, min: 1 },
  },
  { timestamps: true }
);

userExerciseSettingSchema.index({ user: 1, exercise: 1 }, { unique: true });

export const UserExerciseSetting = mongoose.model("UserExerciseSetting", userExerciseSettingSchema);
