import httpStatus from "http-status";
import mongoose from "mongoose";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { Payment } from "../models/payment.model.js";
import { User } from "../models/user.model.js";
import { getPlanByKey as getStaticPlanByKey } from "../constants/subscriptionPlans.js";
import { getPlanByKey as getDbPlanByKey } from "../services/subscriptionPlan.service.js";
import { assertPremiumCapacityAvailable } from "../services/premiumCapacity.service.js";
import { sendEmail } from "../services/email.service.js";
import { buildPaymentReceiptEmail } from "../utils/emailTemplates.js";
import { serializeUser } from "../utils/serializeUser.js";
import {
  createHostedDebit,
  getTransactionStatus,
  verifyAllSecureCallback,
} from "../services/allsecure.service.js";

const SUCCESS_STATUSES = new Set(["SUCCESS", "OK"]);
const FAILED_STATUSES = new Set(["ERROR", "FAILED", "FAILURE", "CANCELLED", "CANCELED", "DECLINED"]);

const publicBaseUrl = () =>
  String(
    process.env.BACKEND_PUBLIC_URL ||
      process.env.BACKEND_URL ||
      process.env.API_BASE_URL ||
      "http://localhost:8000"
  )
    .trim()
    .replace(/\/+$/, "");

const paymentResponse = (payment) => ({
  id: payment._id,
  planKey: payment.planKey,
  planName: payment.planName,
  amount: payment.amount,
  currency: payment.currency,
  status: payment.status,
  paymentMethod: payment.paymentMethod,
  provider: payment.provider,
  transactionId: payment.transactionId,
  cardLast4: payment.cardLast4,
  cardBrand: payment.cardBrand,
  paidAt: payment.paidAt || null,
  failureReason: payment.failureReason || null,
  metadata: payment.metadata || {},
  createdAt: payment.createdAt,
  updatedAt: payment.updatedAt,
});

const addMonths = (date, months) => {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
};

const resolvePlan = async (planKey) => (await getDbPlanByKey(planKey)) || getStaticPlanByKey(planKey) || null;

const activateSubscription = async (payment) => {
  if (payment.metadata?.subscriptionActivatedAt) return;

  const [user, plan] = await Promise.all([User.findById(payment.user), resolvePlan(payment.planKey)]);
  if (!user || !user.isActive || !plan) return;

  await assertPremiumCapacityAvailable({ user, planKey: plan.key });
  const startedAt = payment.paidAt || new Date();
  user.selectedPlan = plan.key;
  user.subscriptionStatus = "active";
  user.subscriptionStartedAt = startedAt;
  user.subscriptionEndsAt = addMonths(startedAt, plan.durationMonths || 1);
  user.trialActivatedAt = null;
  user.trialEndsAt = null;
  await user.save({ validateBeforeSave: false });

  payment.metadata = { ...(payment.metadata || {}), subscriptionActivatedAt: new Date().toISOString() };
  await payment.save({ validateBeforeSave: false });

  try {
    const receipt = buildPaymentReceiptEmail({
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
    await sendEmail({ to: user.email, subject: receipt.subject, html: receipt.html, text: receipt.text });
  } catch (error) {
    console.error(`[allsecure] Failed to send receipt email: ${error.message}`);
  }
};

const gatewayErrorReason = (data) =>
  String(data?.errors?.[0]?.message || data?.errors?.[0]?.errorMessage || data?.errorMessage || "Payment failed.")
    .trim()
    .slice(0, 180);

const cardDataFrom = (data) => data?.returnData?.creditcardData || data?.returnData?.cardData || {};

const synchronizePayment = async (payment, gatewayData) => {
  const gatewayStatus = String(gatewayData.transactionStatus || gatewayData.result || "PENDING").toUpperCase();
  const cardData = cardDataFrom(gatewayData);
  payment.transactionId = String(gatewayData.uuid || payment.transactionId || "");
  payment.cardBrand = String(cardData.binBrand || cardData.type || payment.cardBrand || "").slice(0, 24);
  payment.cardLast4 = String(cardData.lastFourDigits || payment.cardLast4 || "").slice(-4);
  payment.metadata = {
    ...(payment.metadata || {}),
    allSecureUuid: String(gatewayData.uuid || payment.metadata?.allSecureUuid || ""),
    allSecurePurchaseId: String(gatewayData.purchaseId || payment.metadata?.allSecurePurchaseId || ""),
    allSecureStatus: gatewayStatus,
  };

  if (SUCCESS_STATUSES.has(gatewayStatus)) {
    payment.status = "succeeded";
    payment.paidAt ||= new Date();
    payment.failureReason = "";
    await payment.save({ validateBeforeSave: false });
    await activateSubscription(payment);
  } else if (FAILED_STATUSES.has(gatewayStatus) && payment.status !== "succeeded") {
    payment.status = "failed";
    payment.failureReason = gatewayErrorReason(gatewayData);
    await payment.save({ validateBeforeSave: false });
  } else {
    await payment.save({ validateBeforeSave: false });
  }

  return gatewayStatus;
};

const findPayment = async (identifier) => {
  const value = String(identifier || "").trim();
  if (!value) return null;
  if (mongoose.isValidObjectId(value)) {
    const byId = await Payment.findOne({ _id: value, provider: "allsecure" });
    if (byId) return byId;
  }
  return Payment.findOne({
    provider: "allsecure",
    $or: [{ transactionId: value }, { "metadata.merchantTransactionId": value }],
  });
};

export const allSecureCheckout = catchAsync(async (req, res) => {
  const planKey = String(req.body.planKey || req.user.selectedPlan || "").trim().toLowerCase();
  if (!planKey) throw new AppError("planKey is required.", httpStatus.BAD_REQUEST);

  const plan = await getDbPlanByKey(planKey);
  if (!plan) throw new AppError("Invalid planKey provided.", httpStatus.BAD_REQUEST);
  if (Number(plan.price || 0) <= 0) {
    throw new AppError("Hosted payment is only available for paid plans.", httpStatus.BAD_REQUEST);
  }
  await assertPremiumCapacityAvailable({ user: req.user, planKey: plan.key });

  const billingDetails = req.body.billingDetails || {};
  const billingAddress1 = String(billingDetails.address || "").trim();
  const billingCity = String(billingDetails.city || "").trim();
  const billingPostcode = String(billingDetails.postcode || "").trim();
  const billingCountry = String(billingDetails.country || "").trim().toUpperCase();
  const billingState = String(billingDetails.state || "").trim().toUpperCase();
  if (
    !billingAddress1 ||
    !billingCity ||
    !billingPostcode ||
    !billingState ||
    !/^[A-Z]{2}$/.test(billingCountry)
  ) {
    throw new AppError(
      "A billing address, city, postcode, state/municipality code, and two-letter country code are required.",
      httpStatus.BAD_REQUEST
    );
  }
  if (billingState.length > 3) {
    throw new AppError("Billing state/municipality code must not exceed 3 characters.", httpStatus.BAD_REQUEST);
  }

  const currency = String(process.env.ALLSECURE_CURRENCY || "EUR").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AppError("ALLSECURE_CURRENCY must be a three-letter currency code.", httpStatus.INTERNAL_SERVER_ERROR);
  }

  const payment = await Payment.create({
    user: req.user._id,
    planKey: plan.key,
    planName: plan.name,
    amount: plan.price,
    currency,
    status: "pending",
    paymentMethod: "card",
    provider: "allsecure",
    transactionId: "",
    metadata: { source: "allsecure_hosted_payment" },
  });

  const merchantTransactionId = `DMNE-${payment._id}`;
  const routeBase = `${publicBaseUrl()}/api/v1/payments/allsecure`;
  const language = String(req.body.language || req.user.preferredLanguage || "en").trim().toLowerCase().slice(0, 2);
  const payload = {
    merchantTransactionId,
    merchantMetaData: `paymentId=${payment._id}|userId=${req.user._id}|planKey=${plan.key}`,
    amount: Number(plan.price).toFixed(2),
    currency,
    successUrl: `${routeBase}/success`,
    cancelUrl: `${routeBase}/cancel`,
    errorUrl: `${routeBase}/error`,
    callbackUrl: `${routeBase}/callback`,
    description: String(plan.durationLabel || plan.name).slice(0, 255),
    transactionIndicator: "SINGLE",
    customer: {
      identification: String(req.user._id),
      firstName: String(req.user.firstName || "Customer").slice(0, 50),
      lastName: String(req.user.lastName || "Customer").slice(0, 50),
      email: String(req.user.email || "").slice(0, 100),
      emailVerified: true,
      ipAddress: String(req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, ""),
      billingAddress1: billingAddress1.slice(0, 100),
      billingCity: billingCity.slice(0, 50),
      billingPostcode: billingPostcode.slice(0, 16),
      billingCountry,
      billingState,
      ...(req.user.phone ? { billingPhone: String(req.user.phone).slice(0, 32) } : {}),
    },
    threeDSecureData: { "3dsecure": "MANDATORY" },
    language: /^[a-z]{2}$/.test(language) ? language : "en",
  };

  try {
    const result = await createHostedDebit(payload);
    const redirectUrl = String(result.redirectUrl || "").trim();
    if (String(result.returnType || "").toUpperCase() !== "REDIRECT" || !redirectUrl) {
      throw new AppError("AllSecure did not return a hosted payment URL.", httpStatus.BAD_GATEWAY);
    }

    payment.transactionId = String(result.uuid || "");
    payment.metadata = {
      ...(payment.metadata || {}),
      merchantTransactionId,
      allSecureUuid: String(result.uuid || ""),
      allSecurePurchaseId: String(result.purchaseId || ""),
      returnType: String(result.returnType || ""),
      redirectType: String(result.redirectType || ""),
    };
    await payment.save({ validateBeforeSave: false });

    return res.status(httpStatus.CREATED).json({
      success: true,
      message: "AllSecure hosted payment created successfully.",
      data: {
        checkoutUrl: redirectUrl,
        sessionId: merchantTransactionId,
        payment: paymentResponse(payment),
        user: serializeUser(req.user),
      },
    });
  } catch (error) {
    payment.status = "failed";
    payment.failureReason = String(error.message || "Unable to create hosted payment.").slice(0, 180);
    await payment.save({ validateBeforeSave: false });
    throw error;
  }
});

export const confirmAllSecureCheckout = catchAsync(async (req, res) => {
  const sessionId = String(req.body.sessionId || req.params.sessionId || req.query.sessionId || "").trim();
  if (!sessionId) throw new AppError("sessionId is required.", httpStatus.BAD_REQUEST);

  const payment = await findPayment(sessionId);
  if (!payment) throw new AppError("Payment not found.", httpStatus.NOT_FOUND);
  if (String(payment.user) !== String(req.user._id)) {
    throw new AppError("You are not allowed to access this payment.", httpStatus.FORBIDDEN);
  }

  const merchantTransactionId = payment.metadata?.merchantTransactionId;
  if (!merchantTransactionId) throw new AppError("Payment reference is missing.", httpStatus.BAD_REQUEST);
  const statusResult = await getTransactionStatus(merchantTransactionId);
  const gatewayStatus = await synchronizePayment(payment, statusResult);
  const [freshPayment, freshUser] = await Promise.all([Payment.findById(payment._id), User.findById(req.user._id)]);

  res.status(httpStatus.OK).json({
    success: true,
    message: "AllSecure payment status synchronized.",
    data: {
      sessionId: merchantTransactionId,
      gatewayStatus,
      payment: freshPayment ? paymentResponse(freshPayment) : null,
      user: freshUser ? serializeUser(freshUser) : null,
    },
  });
});

export const allSecureCallback = async (req, res) => {
  const rawBody = req.rawBody?.toString("utf8") || JSON.stringify(req.body || {});
  const date = String(req.headers["x-date"] || req.headers.date || "");
  const contentType = String(req.headers["content-type"] || "application/json");
  const valid = verifyAllSecureCallback({
    method: req.method,
    body: rawBody,
    contentType,
    date,
    requestUri: req.originalUrl,
    signature: req.headers["x-signature"],
  });
  if (!valid) return res.status(httpStatus.UNAUTHORIZED).type("text").send("Invalid signature");

  try {
    const merchantTransactionId = String(req.body?.merchantTransactionId || "").trim();
    const payment = await findPayment(merchantTransactionId);
    if (!payment) return res.status(httpStatus.NOT_FOUND).type("text").send("Payment not found");

    const amountMatches = Number(req.body?.amount) === Number(payment.amount);
    const currencyMatches = String(req.body?.currency || "").toUpperCase() === payment.currency;
    if (!amountMatches || !currencyMatches) {
      return res.status(httpStatus.BAD_REQUEST).type("text").send("Payment data mismatch");
    }

    await synchronizePayment(payment, req.body);
    return res.status(httpStatus.OK).type("text").send("OK");
  } catch (error) {
    console.error(`[allsecure] Callback processing failed: ${error.message}`);
    return res.status(httpStatus.INTERNAL_SERVER_ERROR).type("text").send("Callback processing failed");
  }
};

const redirectPage = (title, message) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:Arial,sans-serif;background:#f6f8fa;color:#111827;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}.card{background:#fff;padding:28px;border-radius:14px;box-shadow:0 10px 30px #0001;max-width:520px}h1{font-size:22px}p{line-height:1.6}</style></head><body><main class="card"><h1>${title}</h1><p>${message}</p></main></body></html>`;

export const allSecureSuccessPage = (req, res) =>
  res.status(httpStatus.OK).type("html").send(redirectPage("Payment received", "Your payment is being verified. You can return to the app now."));
export const allSecureCancelPage = (req, res) =>
  res.status(httpStatus.OK).type("html").send(redirectPage("Payment canceled", "No payment was completed. You can return to the app and try again."));
export const allSecureErrorPage = (req, res) =>
  res.status(httpStatus.OK).type("html").send(redirectPage("Payment unsuccessful", "The payment could not be completed. Return to the app and try again."));
