import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { User } from "../models/user.model.js";
import { Payment } from "../models/payment.model.js";
import { resolvePlanKeyFromAppleProduct } from "../constants/appleIapProducts.js";
import { getPlanByKey as getStaticPlanByKey } from "../constants/subscriptionPlans.js";
import { getPlanByKey as getDbPlanByKey } from "./subscriptionPlan.service.js";
import { recordSubscriptionHistory } from "./subscriptionSync.service.js";

const decodeJwsPayload = (jws) => {
  const parts = String(jws || "").split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

const resolvePlan = async (planKey) => {
  const fromDb = await getDbPlanByKey(planKey);
  if (fromDb) return fromDb;
  return getStaticPlanByKey(planKey) || null;
};

const findUserForAppleTransaction = async ({ originalTransactionId, transactionId }) => {
  const originalId = String(originalTransactionId || "").trim();
  const txId = String(transactionId || "").trim();

  if (originalId) {
    const byOriginal = await User.findOne({ appleOriginalTransactionId: originalId });
    if (byOriginal) return byOriginal;
  }

  const payment = await Payment.findOne({
    provider: "apple",
    $or: [
      ...(txId ? [{ transactionId: txId }] : []),
      ...(originalId
        ? [{ "metadata.originalTransactionId": originalId }, { transactionId: originalId }]
        : []),
    ],
  }).sort({ paidAt: -1, createdAt: -1 });

  if (payment?.user) {
    return User.findById(payment.user);
  }

  return null;
};

const activateFromNotification = async ({
  user,
  plan,
  transaction,
  reason,
}) => {
  const previousStatus = String(user.subscriptionStatus || "none").toLowerCase();
  const previousPlanKey = String(user.selectedPlan || "");
  const paidAt = transaction.purchaseDate
    ? new Date(Number(transaction.purchaseDate))
    : new Date();
  const endsAt = transaction.expiresDate
    ? new Date(Number(transaction.expiresDate))
    : null;

  user.selectedPlan = plan.key;
  user.subscriptionStatus = "active";
  user.subscriptionStartedAt = user.subscriptionStartedAt || paidAt;
  user.trialActivatedAt = null;
  user.trialEndsAt = null;
  if (endsAt) user.subscriptionEndsAt = endsAt;
  if (transaction.originalTransactionId) {
    user.appleOriginalTransactionId = String(transaction.originalTransactionId);
  }

  await user.save({ validateBeforeSave: false });
  await recordSubscriptionHistory({
    user,
    previousStatus,
    newStatus: "active",
    previousPlanKey,
    planKey: plan.key,
    reason,
    metadata: {
      source: "apple_server_notification",
      transactionId: transaction.transactionId || "",
      originalTransactionId: transaction.originalTransactionId || "",
      productId: transaction.productId || "",
    },
  });
};

const expireFromNotification = async ({ user, reason, transaction }) => {
  const previousStatus = String(user.subscriptionStatus || "none").toLowerCase();
  const previousPlanKey = String(user.selectedPlan || "");
  const endsAt = transaction?.expiresDate
    ? new Date(Number(transaction.expiresDate))
    : new Date();

  user.subscriptionStatus = "expired";
  user.subscriptionEndsAt = endsAt;

  await user.save({ validateBeforeSave: false });
  await recordSubscriptionHistory({
    user,
    previousStatus,
    newStatus: "expired",
    previousPlanKey,
    planKey: previousPlanKey,
    reason,
    metadata: {
      source: "apple_server_notification",
      transactionId: transaction?.transactionId || "",
      originalTransactionId: transaction?.originalTransactionId || "",
      productId: transaction?.productId || "",
    },
  });
};

/**
 * Handle App Store Server Notifications V2.
 * Configure URL in App Store Connect → App → App Store Server Notifications:
 *   POST {{BACKEND_PUBLIC_URL}}/api/v1/payments/apple/notifications
 */
export const processAppleServerNotification = async (signedPayload) => {
  const payload = decodeJwsPayload(signedPayload);
  if (!payload) {
    throw new AppError("Invalid Apple notification payload.", httpStatus.BAD_REQUEST);
  }

  const notificationType = String(payload.notificationType || "").toUpperCase();
  const subtype = String(payload.subtype || "").toUpperCase();
  const data = payload.data || {};
  const transaction = decodeJwsPayload(data.signedTransactionInfo) || {};
  const renewalInfo = decodeJwsPayload(data.signedRenewalInfo) || {};

  const productId =
    transaction.productId ||
    renewalInfo.autoRenewProductId ||
    renewalInfo.productId ||
    "";
  const planKey = resolvePlanKeyFromAppleProduct(productId);
  const plan = planKey ? await resolvePlan(planKey) : null;

  const user = await findUserForAppleTransaction({
    originalTransactionId: transaction.originalTransactionId || renewalInfo.originalTransactionId,
    transactionId: transaction.transactionId,
  });

  if (!user) {
    console.warn(
      `[apple-notification] No user for ${notificationType}/${subtype} product=${productId} original=${transaction.originalTransactionId || ""}`
    );
    return {
      handled: false,
      reason: "user_not_found",
      notificationType,
      subtype,
    };
  }

  const renewTypes = new Set([
    "DID_RENEW",
    "SUBSCRIBED",
    "OFFER_REDEEMED",
    "DID_CHANGE_RENEWAL_PREF",
    "DID_CHANGE_RENEWAL_STATUS",
  ]);
  const expireTypes = new Set([
    "EXPIRED",
    "GRACE_PERIOD_EXPIRED",
    "REVOKE",
    "REFUND",
  ]);

  if (notificationType === "DID_FAIL_TO_RENEW") {
    // Keep access until expiresDate; mark nothing unless already past.
    if (transaction.expiresDate && Number(transaction.expiresDate) <= Date.now()) {
      await expireFromNotification({
        user,
        reason: "apple_failed_renewal_expired",
        transaction,
      });
      return { handled: true, notificationType, subtype, action: "expired" };
    }
    return { handled: true, notificationType, subtype, action: "billing_retry" };
  }

  if (expireTypes.has(notificationType)) {
    await expireFromNotification({
      user,
      reason: `apple_${notificationType.toLowerCase()}`,
      transaction,
    });
    return { handled: true, notificationType, subtype, action: "expired" };
  }

  if (renewTypes.has(notificationType) || notificationType === "ONE_TIME_CHARGE") {
    if (!plan) {
      console.warn(`[apple-notification] Unknown product ${productId} for ${notificationType}`);
      return { handled: false, reason: "unknown_product", notificationType, subtype };
    }

    // Auto-renew turned off: keep access until current period ends.
    if (notificationType === "DID_CHANGE_RENEWAL_STATUS" && subtype === "AUTO_RENEW_DISABLED") {
      if (transaction.expiresDate) {
        user.subscriptionEndsAt = new Date(Number(transaction.expiresDate));
        await user.save({ validateBeforeSave: false });
      }
      return { handled: true, notificationType, subtype, action: "auto_renew_disabled" };
    }

    await activateFromNotification({
      user,
      plan,
      transaction,
      reason: `apple_${notificationType.toLowerCase()}`,
    });

    // Record renewal payment when Apple issues a new transaction id.
    const txId = String(transaction.transactionId || "").trim();
    if (txId) {
      const existing = await Payment.findOne({ provider: "apple", transactionId: txId });
      if (!existing) {
        await Payment.create({
          user: user._id,
          planKey: plan.key,
          planName: plan.name,
          amount: plan.price,
          currency: "USD",
          status: "succeeded",
          paymentMethod: "apple_iap",
          provider: "apple",
          transactionId: txId,
          paidAt: transaction.purchaseDate
            ? new Date(Number(transaction.purchaseDate))
            : new Date(),
          metadata: {
            productId,
            originalTransactionId: transaction.originalTransactionId || "",
            expiresDateMs: transaction.expiresDate || "",
            source: "apple_server_notification",
            notificationType,
            subtype,
          },
        });
      }
    }

    return { handled: true, notificationType, subtype, action: "activated" };
  }

  console.log(`[apple-notification] Ignored ${notificationType}/${subtype}`);
  return { handled: true, notificationType, subtype, action: "ignored" };
};
