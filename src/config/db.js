import mongoose from "mongoose";

export const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is missing in environment variables.");

  mongoose.set("strictQuery", true);

  await mongoose.connect(uri);

  // eslint-disable-next-line no-console
  console.log("MongoDB connected:", mongoose.connection.host);
};
