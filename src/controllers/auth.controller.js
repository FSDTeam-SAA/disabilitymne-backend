import crypto from "crypto";
import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import {
  getRefreshTokenExpiresIn,
  parseExpiresInToMs,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../utils/authToken.js";
import { sendEmail } from "../services/email.service.js";
import { buildPasswordResetOtpEmail } from "../utils/emailTemplates.js";
import { serializeUser } from "../utils/serializeUser.js";
import { User } from "../models/user.model.js";

const getNormalizedEmail = (email) => String(email || "").trim().toLowerCase(); 

const getOtpExpiryMinutes = () => {
  const parsed = Number(process.env.OTP_EXPIRES_MINUTES || 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
};

const createOtp = () => String(crypto.randomInt(100000, 1000000));

const getRefreshTtlMs = () => parseExpiresInToMs(getRefreshTokenExpiresIn(), 30 * 24 * 60 * 60 * 1000);

const issueAndPersistTokens = async (user, options = {}) => {
  const { updateLastLogin = false, saveOptions = { validateBeforeSave: false } } = options;

  const accessToken = signAccessToken(user._id.toString());
  const refreshToken = signRefreshToken(user._id.toString());

  user.setRefreshToken(refreshToken, getRefreshTtlMs());

  if (updateLastLogin) {
    user.lastLoginAt = new Date();
  }

  await user.save(saveOptions);

  return { accessToken, refreshToken };
};

const authResponseData = (user, tokens) => ({
  token: tokens.accessToken,
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken,
  user: serializeUser(user),
});

const extractRefreshTokenFromRequest = (req) => {
  const fromBody = String(req.body?.refreshToken || "").trim();
  if (fromBody) {
    return fromBody;
  }

  const fromHeader = String(req.headers["x-refresh-token"] || "").trim();
  if (fromHeader) {
    return fromHeader;
  }

  const authHeader = String(req.headers.authorization || "").trim();
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }

  return "";
};

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
  const tokens = await issueAndPersistTokens(user, { updateLastLogin: true });

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Account created successfully.",
    data: authResponseData(user, tokens),
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

  const accountStatus = user.accountStatus || (user.isActive ? "active" : "deactivated");
  if (!user.isActive || accountStatus !== "active") {
    throw new AppError("Your account is not active. Contact support@disabilitymne.com.", httpStatus.FORBIDDEN);
  }
  const tokens = await issueAndPersistTokens(user, { updateLastLogin: true });

  res.status(httpStatus.OK).json({
    success: true,
    message: "Logged in successfully.",
    data: authResponseData(user, tokens),
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
  const otpExpiryMinutes = getOtpExpiryMinutes();
  user.setPasswordResetOtp(otp, otpExpiryMinutes);
  await user.save({ validateBeforeSave: false });

  const emailTemplate = buildPasswordResetOtpEmail({
    firstName: user.firstName,
    otp,
    expiresInMinutes: otpExpiryMinutes,
  });

  await sendEmail({
    to: user.email,
    subject: emailTemplate.subject,
    html: emailTemplate.html,
    text: emailTemplate.text,
  });

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
  const tokens = await issueAndPersistTokens(user, { saveOptions: {} });

  res.status(httpStatus.OK).json({
    success: true,
    message: "Password reset successful.",
    data: authResponseData(user, tokens),
  });
});

export const refreshAccessToken = catchAsync(async (req, res) => {
  const refreshToken = extractRefreshTokenFromRequest(req);

  if (!refreshToken) {
    throw new AppError("refreshToken is required.", httpStatus.BAD_REQUEST);
  }

  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    throw new AppError("Invalid or expired refresh token.", httpStatus.UNAUTHORIZED);
  }

  if (decoded.type && decoded.type !== "refresh") {
    throw new AppError("Invalid refresh token type.", httpStatus.UNAUTHORIZED);
  }

  const user = await User.findById(decoded.id).select("+refreshTokenHash +refreshTokenExpiresAt");

  const accountStatus = user?.accountStatus || (user?.isActive ? "active" : "deactivated");
  if (!user || !user.isActive || accountStatus !== "active") {
    throw new AppError("User no longer exists or account is inactive.", httpStatus.UNAUTHORIZED);
  }

  if (user.passwordChangedAt) {
    const passwordChangedAtSec = Math.floor(user.passwordChangedAt.getTime() / 1000);
    if (decoded.iat < passwordChangedAtSec) {
      throw new AppError("Password changed recently. Please log in again.", httpStatus.UNAUTHORIZED);
    }
  }

  if (!user.isRefreshTokenValid(refreshToken)) {
    throw new AppError("Refresh token is no longer valid. Please log in again.", httpStatus.UNAUTHORIZED);
  }

  const tokens = await issueAndPersistTokens(user);

  res.status(httpStatus.OK).json({
    success: true,
    message: "Token refreshed successfully.",
    data: authResponseData(user, tokens),
  });
});

export const logout = catchAsync(async (req, res) => {
  req.user.clearRefreshToken();
  await req.user.save({ validateBeforeSave: false });

  res.status(httpStatus.OK).json({
    success: true,
    message: "Logged out successfully.",
  });
});
