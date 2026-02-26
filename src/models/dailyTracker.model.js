import mongoose from "mongoose";

const trackerHabitSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    icon: { type: String, default: "", trim: true },
    days: {
      type: [Boolean],
      default: [false, false, false, false, false, false, false],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length === 7,
        message: "days must contain exactly 7 values.",
      },
    },
  },
  { _id: false }
);

const trackerNoteSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: true,
      trim: true,
      maxlength: [500, "Note should not exceed 500 characters"],
    },
    dayIndex: {
      type: Number,
      min: 1,
      max: 7,
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const dailyTrackerSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    weekStartDate: {
      type: Date,
      required: true,
      index: true,
    },
    weekNumber: {
      type: Number,
      min: 1,
      max: 54,
      required: true,
    },
    habits: {
      type: [trackerHabitSchema],
      default: [],
    },
    notes: {
      type: [trackerNoteSchema],
      default: [],
    },
    completionRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
  },
  { timestamps: true }
);

dailyTrackerSchema.index({ user: 1, weekStartDate: 1 }, { unique: true });

dailyTrackerSchema.pre("save", function preSave(next) {
  const totalCells = (this.habits || []).reduce((sum, habit) => sum + (habit.days?.length || 0), 0);
  const completedCells = (this.habits || []).reduce(
    (sum, habit) => sum + (habit.days || []).filter(Boolean).length,
    0
  );
  this.completionRate = totalCells > 0 ? Number(((completedCells / totalCells) * 100).toFixed(2)) : 0;
  next();
});

export const DailyTracker = mongoose.model("DailyTracker", dailyTrackerSchema);
