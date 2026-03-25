import mongoose from "mongoose";

const weightMeasurementSnapshotSchema = new mongoose.Schema(
  {
    value: { type: Number, min: 0, required: true },
    unit: { type: String, enum: ["kg", "lbs"], required: true },
  },
  { _id: false }
);

const weightLogSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    weightKg: {
      type: Number,
      required: true,
      min: 0,
    },
    measurement: {
      type: weightMeasurementSnapshotSchema,
      required: true,
    },
    source: {
      type: String,
      enum: ["onboarding", "profile_update"],
      default: "profile_update",
    },
    recordedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

weightLogSchema.index({ user: 1, recordedAt: -1 });

export const WeightLog = mongoose.model("WeightLog", weightLogSchema);
