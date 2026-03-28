import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import { Program } from "../src/models/program.model.js";

const DEFAULT_DAY_INDICES = [1, 3, 5];

const distributeAcrossDefaultDays = (exerciseRefs = []) => {
  const buckets = new Map(DEFAULT_DAY_INDICES.map((dayIndex) => [dayIndex, []]));

  for (let index = 0; index < exerciseRefs.length; index += 1) {
    const dayIndex = DEFAULT_DAY_INDICES[index % DEFAULT_DAY_INDICES.length];
    buckets.get(dayIndex).push(exerciseRefs[index]);
  }

  return DEFAULT_DAY_INDICES
    .map((dayIndex) => ({
      dayIndex,
      exerciseRefs: buckets.get(dayIndex) || [],
    }))
    .filter((day) => day.exerciseRefs.length > 0);
};

const run = async () => {
  await connectDB();

  const programs = await Program.find({
    $or: [
      { workoutDays: { $exists: false } },
      { workoutDays: { $size: 0 } },
    ],
  }).select("_id exerciseRefs exercises totalExercises workoutDays");

  let updatedCount = 0;

  for (const program of programs) {
    const exerciseRefs = Array.isArray(program.exerciseRefs)
      ? program.exerciseRefs.filter(Boolean)
      : [];

    if (exerciseRefs.length === 0) {
      continue;
    }

    const workoutDays = distributeAcrossDefaultDays(exerciseRefs);
    if (workoutDays.length === 0) {
      continue;
    }

    const uniqueExerciseRefs = [
      ...new Set(workoutDays.flatMap((day) => day.exerciseRefs.map((exerciseRef) => exerciseRef.toString()))),
    ].map((id) => new mongoose.Types.ObjectId(id));

    program.workoutDays = workoutDays;
    program.exerciseRefs = uniqueExerciseRefs;
    program.totalExercises = uniqueExerciseRefs.length;
    program.exercises = [];
    await program.save();
    updatedCount += 1;
  }

  // eslint-disable-next-line no-console
  console.log(`Program workout day migration complete. Updated programs: ${updatedCount}`);
  await mongoose.connection.close();
};

run().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error("Program workout day migration failed:", error);
  await mongoose.connection.close();
  process.exit(1);
});
