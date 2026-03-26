import mongoose from "mongoose";

const userProgramSchema = new mongoose.Schema(
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
    startedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    lastStartedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

userProgramSchema.index({ user: 1, program: 1 }, { unique: true });
userProgramSchema.index({ user: 1, lastStartedAt: -1 });

export const UserProgram = mongoose.model("UserProgram", userProgramSchema);
