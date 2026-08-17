import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import { seedDefaultHomeBannerIfEmpty } from "../src/services/homeBannerSeed.service.js";

const run = async () => {
  await connectDB();
  const result = await seedDefaultHomeBannerIfEmpty();

  if (result.seeded) {
    console.log(`Seeded default homepage banner (${result.id}): ${result.imageUrl}`);
  } else {
    console.log("Default homepage banner already exists. Skipping seed.");
  }

  await mongoose.connection.close();
};

run().catch(async (error) => {
  console.error("Failed to seed default homepage banner:", error);
  await mongoose.connection.close();
  process.exit(1);
});
