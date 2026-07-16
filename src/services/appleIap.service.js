import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VERIFY_URL_PRODUCTION = "https://buy.itunes.apple.com/verifyReceipt";
const VERIFY_URL_SANDBOX = "https://sandbox.itunes.apple.com/verifyReceipt";
const STOREKIT_API_PRODUCTION = "https://api.storekit.itunes.apple.com";
const STOREKIT_API_SANDBOX = "https://api.storekit-sandbox.itunes.apple.com";
const EXPECTED_BUNDLE_ID = String(process.env.APPLE_BUNDLE_ID || "com.disability.disabilitymn").trim();

const addMonths = (date, months) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
};

const getSharedSecret = () => String(process.env.APPLE_IAP_SHARED_SECRET || "").trim();

const getIssuerId = () => String(process.env.APPLE_IAP_ISSUER_ID || "").trim();
const getKeyId = () => String(process.env.APPLE_IAP_KEY_ID || "").trim();

const getPrivateKeyPem = () => {
  const inline = String(process.env.APPLE_IAP_PRIVATE_KEY || "").trim();
  if (inline) {
    return inline.replace(/\\n/g, "\n");
  }

  const configuredPath = String(process.env.APPLE_IAP_PRIVATE_KEY_PATH || "").trim();
  const resolvedPath = configuredPath
    ? path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(process.cwd(), configuredPath)
    : path.resolve(__dirname, "../../keys/SubscriptionKey_2C8SJG8F46.p8");

  if (!fs.existsSync(resolvedPath)) {
    return "";
  }

  return fs.readFileSync(resolvedPath, "utf8");
};

const hasAppStoreServerApiConfig = () => {
  return Boolean(getIssuerId() && getKeyId() && getPrivateKeyPem());
};

const assertAppleIapConfigured = () => {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  if (hasAppStoreServerApiConfig() || getSharedSecret()) {
    return;
  }

  throw new AppError(
    "Apple IAP is not configured on the server. Set APPLE_IAP_SHARED_SECRET or App Store Server API keys.",
    httpStatus.INTERNAL_SERVER_ERROR
  );
};

const createAppStoreServerToken = () => {
  const issuerId = getIssuerId();
  const keyId = getKeyId();
  const privateKey = getPrivateKeyPem();

  if (!issuerId || !keyId || !privateKey) {
    throw new AppError(
      "Apple App Store Server API credentials are not configured.",
      httpStatus.INTERNAL_SERVER_ERROR
    );
  }

  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: issuerId,
      iat: now,
      exp: now + 60 * 20,
      aud: "appstoreconnect-v1",
      bid: EXPECTED_BUNDLE_ID,
    },
    privateKey,
    {
      algorithm: "ES256",
      header: {
        alg: "ES256",
        kid: keyId,
        typ: "JWT",
      },
    }
  );
};

const decodeJwsPayload = (jws) => {
  const parts = String(jws || "").split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = 15000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new AppError("Apple receipt verification timed out.", httpStatus.GATEWAY_TIMEOUT);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const fetchTransactionFromStoreKit = async (transactionId, baseUrl) => {
  const token = createAppStoreServerToken();
  const response = await fetchWithTimeout(
    `${baseUrl}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new AppError(
      `Unable to verify Apple transaction (${response.status}). ${bodyText}`.trim(),
      httpStatus.BAD_GATEWAY
    );
  }

  const payload = await response.json();
  const transaction = decodeJwsPayload(payload.signedTransactionInfo);
  if (!transaction) {
    throw new AppError("Apple transaction payload could not be decoded.", httpStatus.BAD_GATEWAY);
  }

  return transaction;
};

const verifyWithAppStoreServerApi = async (transactionId) => {
  assertAppleIapConfigured();

  if (!hasAppStoreServerApiConfig()) {
    return null;
  }

  const normalizedId = String(transactionId || "").trim();
  if (!normalizedId) {
    return null;
  }

  let transaction = await fetchTransactionFromStoreKit(normalizedId, STOREKIT_API_PRODUCTION);
  if (!transaction) {
    transaction = await fetchTransactionFromStoreKit(normalizedId, STOREKIT_API_SANDBOX);
  }

  if (!transaction) {
    throw new AppError("No matching Apple transaction was found.", httpStatus.BAD_REQUEST);
  }

  const bundleId = String(transaction.bundleId || "").trim();
  if (EXPECTED_BUNDLE_ID && bundleId && bundleId !== EXPECTED_BUNDLE_ID) {
    throw new AppError("Apple receipt bundle id does not match this app.", httpStatus.BAD_REQUEST);
  }

  return {
    product_id: transaction.productId,
    transaction_id: transaction.transactionId,
    original_transaction_id: transaction.originalTransactionId,
    purchase_date_ms: transaction.purchaseDate,
    expires_date_ms: transaction.expiresDate,
    environment: transaction.environment,
  };
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
  assertAppleIapConfigured();

  const sharedSecret = getSharedSecret();
  if (!sharedSecret && process.env.NODE_ENV === "production" && !hasAppStoreServerApiConfig()) {
    throw new AppError(
      "Apple IAP shared secret is not configured on the server.",
      httpStatus.INTERNAL_SERVER_ERROR
    );
  }

  const body = {
    "receipt-data": receiptData,
    "exclude-old-transactions": true,
  };

  if (sharedSecret) {
    body.password = sharedSecret;
  }

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new AppError("Unable to verify Apple receipt.", httpStatus.BAD_GATEWAY);
  }

  return response.json();
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

const resolveLatestItem = async ({
  receiptData,
  transactionId,
  expectedProductId,
  normalizedProductId,
}) => {
  // Prefer App Store Server API (Issuer ID + Key ID + .p8) when transaction id is available.
  if (transactionId && hasAppStoreServerApiConfig()) {
    try {
      const item = await verifyWithAppStoreServerApi(transactionId);
      if (item) {
        return item;
      }
    } catch (error) {
      console.error(`[apple-iap] App Store Server API verify failed: ${error.message}`);
      // Fall through to classic verifyReceipt when possible.
      if (!receiptData) {
        throw error;
      }
    }
  }

  if (!receiptData) {
    throw new AppError("Apple receipt data is required.", httpStatus.BAD_REQUEST);
  }

  const receiptResult = await verifyAppleReceipt(receiptData);
  const latestItem = pickLatestSubscription(
    receiptResult,
    expectedProductId || normalizedProductId
  );

  if (!latestItem) {
    throw new AppError("No matching Apple subscription was found in the receipt.", httpStatus.BAD_REQUEST);
  }

  return latestItem;
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

  const latestItem = await resolveLatestItem({
    receiptData,
    transactionId,
    expectedProductId,
    normalizedProductId,
  });

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
      verificationMethod: latestItem.environment ? "app_store_server_api" : "verify_receipt",
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
