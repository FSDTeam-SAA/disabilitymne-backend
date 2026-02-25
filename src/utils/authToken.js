import jwt from "jsonwebtoken";
import AppError from "./AppError.js";

const getJwtSecret = () => {
  if (!process.env.JWT_SECRET) {
    throw new AppError("JWT_SECRET is missing in environment variables.", 500);
  }

  return process.env.JWT_SECRET;
};

export const signToken = (userId) => {
  const expiresIn = process.env.JWT_EXPIRES_IN || "7d";
  return jwt.sign({ id: userId }, getJwtSecret(), { expiresIn });
};

export const verifyToken = (token) => jwt.verify(token, getJwtSecret());
