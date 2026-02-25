import crypto from "crypto";
import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { signToken } from "../utils/authToken.js";
import { serializeUser } from "../utils/serializeUser.js";
import { User } from "../models/user.model.js";

const getNormalizedEmail = (email) => String(email || "").trim().toLowerCase();

const getOtpExpiryMinutes = () => {
  const parsed = Number(process.env.OTP_EXPIRES_MINUTES || 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
};

const createOtp = () => String(crypto.randomInt(100000, 1000000));

export const register = catchAsync(async (req, res) => {
  const { firstName, email, phone, password, confirmPassword } = req.body;
  const normalizedEmail = getNormalizedEmail(email);

  if (!firstName || !normalizedEmail || !password || !confirmPassword) {
    throw new AppError("First name, email, password and confirm password are required.", httpStatus.BAD_REQUEST);
  }

  if (password !== confirmPassword) {
    throw new AppError("Password and confirm password do not match.", httpStatus.BAD_REQUEST);
  }

  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    throw new AppError("An account with this email already exists.", httpStatus.CONFLICT);
  }

  const user = await User.create({
    firstName,
    email: normalizedEmail,
    phone,
    password,
  });

  const token = signToken(user._id.toString());

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Account created successfully.",
    data: {
      token,
      user: serializeUser(user),
    },
  });
});

export const login = catchAsync(async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = getNormalizedEmail(email);

  if (!normalizedEmail || !password) {
    throw new AppError("Email and password are required.", httpStatus.BAD_REQUEST);
  }

  const user = await User.findOne({ email: normalizedEmail }).select("+password");

  if (!user || !(await user.comparePassword(password))) {
    throw new AppError("Invalid email or password.", httpStatus.UNAUTHORIZED);
  }

  if (!user.isActive) {
    throw new AppError("Your account is inactive. Contact support.", httpStatus.FORBIDDEN);
  }

  user.lastLoginAt = new Date();
  await user.save({ validateBeforeSave: false });

  const token = signToken(user._id.toString());

  res.status(httpStatus.OK).json({
    success: true,
    message: "Logged in successfully.",
    data: {
      token,
      user: serializeUser(user),
    },
  });
});

export const sendPasswordResetOtp = catchAsync(async (req, res) => {
  const { email } = req.body;
  const normalizedEmail = getNormalizedEmail(email);

  if (!normalizedEmail) {
    throw new AppError("Email is required.", httpStatus.BAD_REQUEST);
  }

  const genericResponse = {
    success: true,
    message: "If that email exists, an OTP was sent successfully.",
  };

  const user = await User.findOne({ email: normalizedEmail }).select("+passwordResetOtpHash +passwordResetOtpExpiresAt");
  if (!user) {
    return res.status(httpStatus.OK).json(genericResponse);
  }

  const otp = createOtp();
  user.setPasswordResetOtp(otp, getOtpExpiryMinutes());
  await user.save({ validateBeforeSave: false });

  const payload = { ...genericResponse };

  if ((process.env.NODE_ENV || "development") !== "production") {
    payload.data = { devOtp: otp };
  }

  return res.status(httpStatus.OK).json(payload);
});

export const verifyPasswordResetOtp = catchAsync(async (req, res) => {
  const { email, otp } = req.body;
  const normalizedEmail = getNormalizedEmail(email);

  if (!normalizedEmail || !otp) {
    throw new AppError("Email and OTP are required.", httpStatus.BAD_REQUEST);
  }

  const user = await User.findOne({ email: normalizedEmail }).select("+passwordResetOtpHash +passwordResetOtpExpiresAt");

  if (!user || !user.isPasswordResetOtpValid(otp)) {
    throw new AppError("Invalid or expired OTP.", httpStatus.BAD_REQUEST);
  }

  res.status(httpStatus.OK).json({
    success: true,
    message: "OTP verified successfully.",
  });
});

export const resetPassword = catchAsync(async (req, res) => {
  const { email, otp, newPassword, confirmPassword } = req.body;
  const normalizedEmail = getNormalizedEmail(email);

  if (!normalizedEmail || !otp || !newPassword || !confirmPassword) {
    throw new AppError("Email, OTP, new password and confirm password are required.", httpStatus.BAD_REQUEST);
  }

  if (newPassword !== confirmPassword) {
    throw new AppError("New password and confirm password do not match.", httpStatus.BAD_REQUEST);
  }

  const user = await User.findOne({ email: normalizedEmail }).select("+passwordResetOtpHash +passwordResetOtpExpiresAt");

  if (!user || !user.isPasswordResetOtpValid(otp)) {
    throw new AppError("Invalid or expired OTP.", httpStatus.BAD_REQUEST);
  }

  user.password = newPassword;
  user.clearPasswordResetOtp();
  await user.save();

  const token = signToken(user._id.toString());

  res.status(httpStatus.OK).json({
    success: true,
    message: "Password reset successful.",
    data: {
      token,
      user: serializeUser(user),
    },
  });
});
