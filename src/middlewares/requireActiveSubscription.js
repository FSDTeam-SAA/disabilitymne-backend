import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { isSubscriptionCurrentlyActive } from "../utils/access.js";
import { syncUserSubscriptionStatus } from "../services/subscriptionSync.service.js";

/**
 * Blocks app content APIs when the user has no active App Store / paid subscription.
 * Admins and sponsored users are always allowed.
 * Call after `protect`.
 */
export const requireActiveSubscription = catchAsync(async (req, res, next) => {
  const user = req.user;
  if (!user) {
    throw new AppError("You are not logged in.", httpStatus.UNAUTHORIZED);
  }

  if (user.role === "admin") {
    return next();
  }

  if (user.isSponsored) {
    return next();
  }

  await syncUserSubscriptionStatus(user, { reason: "access_check" });

  if (!isSubscriptionCurrentlyActive(user)) {
    throw new AppError(
      "An active Disability Fitness Membership subscription is required to use the app.",
      httpStatus.PAYMENT_REQUIRED
    );
  }

  return next();
});
