import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { verifyToken } from "../utils/authToken.js";
import { User } from "../models/user.model.js";

export const protect = catchAsync(async (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  let token = "";

  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  }

  if (!token) {
    throw new AppError("You are not logged in. Please provide a bearer token.", httpStatus.UNAUTHORIZED);
  }

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    throw new AppError("Invalid or expired token. Please log in again.", httpStatus.UNAUTHORIZED);
  }

  const currentUser = await User.findById(decoded.id);
  if (!currentUser || !currentUser.isActive) {
    throw new AppError("User no longer exists or is inactive.", httpStatus.UNAUTHORIZED);
  }

  if (currentUser.passwordChangedAt) {
    const passwordChangedAtSec = Math.floor(currentUser.passwordChangedAt.getTime() / 1000);
    if (decoded.iat < passwordChangedAtSec) {
      throw new AppError("Password changed recently. Please log in again.", httpStatus.UNAUTHORIZED);
    }
  }

  req.user = currentUser;
  next();
});

export const restrictTo = (...roles) => (req, res, next) => {
  const userRole = req.user?.role || "user";

  if (!roles.includes(userRole)) {
    throw new AppError("You do not have permission to perform this action.", httpStatus.FORBIDDEN);
  }

  next();
};
