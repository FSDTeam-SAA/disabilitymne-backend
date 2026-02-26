import jwt from "jsonwebtoken";
import AppError from "./AppError.js";

const getAccessSecret = () => {
  const secret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new AppError("JWT_ACCESS_SECRET (or JWT_SECRET) is missing in environment variables.", 500);
  }

  return secret;
};

const getRefreshSecret = () => {
  const secret = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new AppError("JWT_REFRESH_SECRET (or JWT_SECRET) is missing in environment variables.", 500);
  }

  return secret;
};

export const getAccessTokenExpiresIn = () => process.env.JWT_ACCESS_EXPIRES_IN || process.env.JWT_EXPIRES_IN || "15m";
export const getRefreshTokenExpiresIn = () => process.env.JWT_REFRESH_EXPIRES_IN || "30d";

export const signAccessToken = (userId) => {
  const expiresIn = getAccessTokenExpiresIn();
  return jwt.sign({ id: userId, type: "access" }, getAccessSecret(), { expiresIn });
};

export const signRefreshToken = (userId) => {
  const expiresIn = getRefreshTokenExpiresIn();
  return jwt.sign({ id: userId, type: "refresh" }, getRefreshSecret(), { expiresIn });
};

export const verifyAccessToken = (token) => jwt.verify(token, getAccessSecret());
export const verifyRefreshToken = (token) => jwt.verify(token, getRefreshSecret());

export const parseExpiresInToMs = (expiresIn, fallbackMs = 30 * 24 * 60 * 60 * 1000) => {
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return Math.round(expiresIn * 1000);
  }

  if (typeof expiresIn !== "string") {
    return fallbackMs;
  }

  const normalized = expiresIn.trim().toLowerCase();
  const match = normalized.match(/^(\d+)\s*([smhd])?$/);
  if (!match) {
    return fallbackMs;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return fallbackMs;
  }

  const unit = match[2] || "s";
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return value * multipliers[unit];
};
