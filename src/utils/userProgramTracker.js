import { UserProgram } from "../models/userProgram.model.js";
import { WorkoutLog } from "../models/workoutLog.model.js";
import { WorkoutExperience } from "../models/workoutExperience.model.js";

const normalizeProgramId = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value?.toString === "function") return value.toString().trim();
  return "";
};

export const collectTrackedProgramIdsForUser = async (userId) => {
  const [startedIds, loggedIds, experienceIds] = await Promise.all([
    UserProgram.distinct("program", { user: userId }),
    WorkoutLog.distinct("program", { user: userId, program: { $ne: null } }),
    WorkoutExperience.distinct("program", { user: userId }),
  ]);

  return [
    ...new Set(
      [...startedIds, ...loggedIds, ...experienceIds]
        .map((programId) => normalizeProgramId(programId))
        .filter(Boolean)
    ),
  ];
};

export const touchUserProgram = async ({ userId, programId, touchedAt = new Date() }) => {
  const touchDate = touchedAt instanceof Date ? touchedAt : new Date(touchedAt);

  return UserProgram.findOneAndUpdate(
    { user: userId, program: programId },
    {
      $set: { lastStartedAt: touchDate },
      $setOnInsert: { startedAt: touchDate },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );
};
