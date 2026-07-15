import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { Payment } from "../models/payment.model.js";
import { User } from "../models/user.model.js";
import { getPlanByKey as getStaticPlanByKey } from "../constants/subscriptionPlans.js";
import { getPlanByKey as getDbPlanByKey } from "../services/subscriptionPlan.service.js";
import { resolvePlanKeyFromAppleProduct, PLAN_TO_APPLE_PRODUCT } from "../constants/appleIapProducts.js";
import { sendEmail } from "../services/email.service.js";
import { buildPaymentReceiptEmail } from "../utils/emailTemplates.js";
import { assertPremiumCapacityAvailable } from "./premiumCapacity.service.js";

const VERIFY_URL_PRODUCTION = "https://buy.itunes.apple.com/verifyReceipt";
const VERIFY_URL_SANDBOX = "https://sandbox.itunes.apple.com/verifyReceipt";
const EXPECTED_BUNDLE_ID = String(process.env.APPLE_BUNDLE_ID || "com.disability.disabilitymn").trim();

const addMonths = (date, months) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
};

const assertSharedSecretConfigured = () => {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  const sharedSecret = String(process.env.APPLE_IAP_SHARED_SECRET || "").trim();
  if (!sharedSecret) {
    throw new AppError(
      "Apple IAP shared secret is not configured on the server.",
      httpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

const validateBundleId = (receiptResult) => {
  const bundleId = String(receiptResult.receipt?.bundle_id || receiptResult.receipt?.bid || "").trim();
  if (!bundleId || !EXPECTED_BUNDLE_ID) {
    return;
  }

  if (bundleId !== EXPECTED_BUNDLE_ID) {
    throw new AppError("Apple receipt bundle id does not match this app.", httpStatus.BAD_REQUEST);
  }
};

const isSubscriptionActive = (item) => {
  const expiresMs = Number(item?.expires_date_ms || 0);
  if (expiresMs > 0) {
    return expiresMs > Date.now();
  }

  return true;
};

const resolvePlanForActivation = async (planKey) => {
  const planFromDb = await getDbPlanByKey(planKey);
  if (planFromDb) return planFromDb;
  return getStaticPlanByKey(planKey) || null;
};

const activateUserPlan = (user, plan, startedAt = new Date(), subscriptionEndsAt = null) => {
  const now = new Date(startedAt);
  user.selectedPlan = plan.key;
  user.subscriptionStartedAt = now;
  user.subscriptionStatus = "active";
  user.trialActivatedAt = null;
  user.trialEndsAt = null;
  user.subscriptionEndsAt =
    subscriptionEndsAt || addMonths(now, plan.durationMonths || 1);
};

const sendPaymentReceipt = async ({ payment, user }) => {
  try {
    const receiptTemplate = buildPaymentReceiptEmail({
      firstName: user.firstName,
      planName: payment.planName,
      amount: payment.amount,
      currency: payment.currency,
      paymentMethod: payment.paymentMethod,
      cardBrand: payment.cardBrand,
      cardLast4: payment.cardLast4,
      transactionId: payment.transactionId,
      paidAt: payment.paidAt,
      subscriptionEndsAt: user.subscriptionEndsAt,
    });

    await sendEmail({
      to: user.email,
      subject: receiptTemplate.subject,
      html: receiptTemplate.html,
      text: receiptTemplate.text,
    });
  } catch (error) {
    console.error(`[apple-iap] Failed to send payment receipt email: ${error.message}`);
  }
};

const postVerifyReceipt = async (url, receiptData) => {
  assertSharedSecretConfigured();

  const sharedSecret = String(process.env.APPLE_IAP_SHARED_SECRET || "").trim();
  const body = {
    "receipt-data": receiptData,
    "exclude-old-transactions": true,
  };

  if (sharedSecret) {
    body.password = sharedSecret;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new AppError("Unable to verify Apple receipt.", httpStatus.BAD_GATEWAY);
    }

    return response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new AppError("Apple receipt verification timed out.", httpStatus.GATEWAY_TIMEOUT);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

export const verifyAppleReceipt = async (receiptData) => {
  const normalizedReceipt = String(receiptData || "").trim();
  if (!normalizedReceipt) {
    throw new AppError("Apple receipt data is required.", httpStatus.BAD_REQUEST);
  }

  let result = await postVerifyReceipt(VERIFY_URL_PRODUCTION, normalizedReceipt);

  if (result.status === 21007) {
    result = await postVerifyReceipt(VERIFY_URL_SANDBOX, normalizedReceipt);
  }

  if (result.status !== 0) {
    throw new AppError(
      `Apple receipt verification failed with status ${result.status}.`,
      httpStatus.BAD_REQUEST
    );
  }

  validateBundleId(result);
  return result;
};

const pickLatestSubscription = (receiptResult, expectedProductId) => {
  const items = [
    ...(Array.isArray(receiptResult.latest_receipt_info) ? receiptResult.latest_receipt_info : []),
    ...(Array.isArray(receiptResult.receipt?.in_app) ? receiptResult.receipt.in_app : []),
  ];

  const matching = items.filter(
    (item) => String(item.product_id || "").toLowerCase() === String(expectedProductId || "").toLowerCase()
  );

  if (matching.length === 0) {
    return null;
  }

  return matching.sort((a, b) => {
    const aTime = Number(a.expires_date_ms || a.purchase_date_ms || 0);
    const bTime = Number(b.expires_date_ms || b.purchase_date_ms || 0);
    return bTime - aTime;
  })[0];
};

const resolveSubscriptionEndsAt = (latestItem, plan, paidAt) => {
  const expiresMs = Number(latestItem.expires_date_ms || 0);
  if (expiresMs > 0) {
    return new Date(expiresMs);
  }

  return addMonths(paidAt, plan.durationMonths || 1);
};

export const processApplePurchase = async ({
  userId,
  receiptData,
  planKey,
  productId,
  transactionId,
}) => {
  const normalizedPlanKey = String(planKey || "").trim().toLowerCase();
  const normalizedProductId = String(productId || "").trim().toLowerCase();
  const resolvedPlanKey = normalizedPlanKey || resolvePlanKeyFromAppleProduct(normalizedProductId);

  if (!resolvedPlanKey) {
    throw new AppError("Unable to resolve subscription plan from Apple product.", httpStatus.BAD_REQUEST);
  }

  const plan = await resolvePlanForActivation(resolvedPlanKey);
  if (!plan) {
    throw new AppError(`Subscription plan "${resolvedPlanKey}" was not found.`, httpStatus.BAD_REQUEST);
  }

  const expectedProductId = normalizedProductId || PLAN_TO_APPLE_PRODUCT[resolvedPlanKey] || "";

  const receiptResult = await verifyAppleReceipt(receiptData);
  const latestItem = pickLatestSubscription(
    receiptResult,
    expectedProductId || normalizedProductId
  );

  if (!latestItem) {
    throw new AppError("No matching Apple subscription was found in the receipt.", httpStatus.BAD_REQUEST);
  }

  if (!isSubscriptionActive(latestItem)) {
    throw new AppError("Apple subscription has expired.", httpStatus.BAD_REQUEST);
  }

  const appleTransactionId = String(
    transactionId || latestItem.transaction_id || latestItem.original_transaction_id || ""
  ).trim();

  if (!appleTransactionId) {
    throw new AppError("Apple transaction id is missing.", httpStatus.BAD_REQUEST);
  }

  const paidAt = latestItem.purchase_date_ms
    ? new Date(Number(latestItem.purchase_date_ms))
    : new Date();
  const subscriptionEndsAt = resolveSubscriptionEndsAt(latestItem, plan, paidAt);

  const existingPayment = await Payment.findOne({
    provider: "apple",
    transactionId: appleTransactionId,
    status: "succeeded",
  });

  const user = await User.findById(userId);
  if (!user || !user.isActive) {
    throw new AppError("User not found.", httpStatus.NOT_FOUND);
  }

  await assertPremiumCapacityAvailable({ user, planKey: plan.key });

  if (existingPayment) {
    if (String(existingPayment.user) !== String(userId)) {
      throw new AppError(
        "This Apple purchase is already linked to another account.",
        httpStatus.CONFLICT
      );
    }

    activateUserPlan(user, plan, paidAt, subscriptionEndsAt);
    await user.save({ validateBeforeSave: false });
    return { payment: existingPayment, user, alreadyProcessed: true };
  }

  const payment = await Payment.create({
    user: userId,
    planKey: plan.key,
    planName: plan.name,
    amount: plan.price,
    currency: String(plan.currency || "USD").toUpperCase(),
    status: "succeeded",
    paymentMethod: "apple_iap",
    provider: "apple",
    transactionId: appleTransactionId,
    paidAt,
    metadata: {
      productId: latestItem.product_id || normalizedProductId,
      originalTransactionId: latestItem.original_transaction_id || "",
      expiresDateMs: latestItem.expires_date_ms || "",
    },
  });

  activateUserPlan(user, plan, payment.paidAt, subscriptionEndsAt);
  await user.save({ validateBeforeSave: false });
  await sendPaymentReceipt({ payment, user });

  return { payment, user, alreadyProcessed: false };
};

export const processAppleRestore = async ({ userId, receiptData }) => {
  const receiptResult = await verifyAppleReceipt(receiptData);
  const items = [
    ...(Array.isArray(receiptResult.latest_receipt_info) ? receiptResult.latest_receipt_info : []),
    ...(Array.isArray(receiptResult.receipt?.in_app) ? receiptResult.receipt.in_app : []),
  ].filter(isSubscriptionActive);

  if (items.length === 0) {
    throw new AppError("No active Apple subscriptions were found to restore.", httpStatus.NOT_FOUND);
  }

  const latestItem = items.sort((a, b) => {
    const aTime = Number(a.expires_date_ms || a.purchase_date_ms || 0);
    const bTime = Number(b.expires_date_ms || b.purchase_date_ms || 0);
    return bTime - aTime;
  })[0];

  const planKey = resolvePlanKeyFromAppleProduct(latestItem.product_id);
  if (!planKey) {
    throw new AppError("Restored Apple product is not linked to a subscription plan.", httpStatus.BAD_REQUEST);
  }

  return processApplePurchase({
    userId,
    receiptData,
    planKey,
    productId: latestItem.product_id,
    transactionId: latestItem.transaction_id,
  });
};
