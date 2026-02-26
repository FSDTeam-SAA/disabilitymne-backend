import httpStatus from "http-status";
import crypto from "crypto";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { Payment } from "../models/payment.model.js";
import { getActivePlans, getPlanByKey } from "../services/subscriptionPlan.service.js";
import { serializeUser } from "../utils/serializeUser.js";

const addMonths = (date, months) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
};

const getCardBrand = (cardNumber) => {
  if (cardNumber.startsWith("4")) return "visa";
  if (cardNumber.startsWith("5")) return "mastercard";
  if (cardNumber.startsWith("3")) return "amex";
  if (cardNumber.startsWith("6")) return "discover";
  return "unknown";
};

const buildPaymentResponse = (payment) => ({
  id: payment._id,
  user: payment.user,
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

const validatePaymentInput = (paymentMethod, paymentDetails) => {
  if (paymentMethod === "manual") {
    return { metadata: {} };
  }

  if (paymentMethod === "bank_account") {
    const accountNumber = String(paymentDetails?.accountNumber || "").replace(/\s+/g, "");
    if (!/^\d{6,20}$/.test(accountNumber)) {
      throw new AppError("A valid bank account number is required.", httpStatus.BAD_REQUEST);
    }

    return {
      metadata: {
        accountLast4: accountNumber.slice(-4),
      },
    };
  }

  if (paymentMethod === "card") {
    const cardNumber = String(paymentDetails?.cardNumber || "").replace(/\s+/g, "");
    const expiryDate = String(paymentDetails?.expiryDate || "").trim();
    const cvv = String(paymentDetails?.cvv || "").trim();

    if (!/^\d{12,19}$/.test(cardNumber)) {
      throw new AppError("A valid card number is required.", httpStatus.BAD_REQUEST);
    }

    if (!/^\d{2}\/\d{2,4}$/.test(expiryDate)) {
      throw new AppError("expiryDate must use MM/YY or MM/YYYY.", httpStatus.BAD_REQUEST);
    }

    if (!/^\d{3,4}$/.test(cvv)) {
      throw new AppError("A valid CVV is required.", httpStatus.BAD_REQUEST);
    }

    return {
      cardLast4: cardNumber.slice(-4),
      cardBrand: getCardBrand(cardNumber),
      metadata: {
        expiryDate,
      },
    };
  }

  throw new AppError("Unsupported payment method.", httpStatus.BAD_REQUEST);
};

const activateUserPlan = (user, plan) => {
  const now = new Date();

  user.selectedPlan = plan.key;
  user.subscriptionStartedAt = now;

  if (plan.price === 0) {
    const trialDays = plan.trialDays || 7;
    user.subscriptionStatus = "trial";
    user.trialActivatedAt = now;
    user.trialEndsAt = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);
    user.subscriptionEndsAt = user.trialEndsAt;
    return;
  }

  user.subscriptionStatus = "active";
  user.trialActivatedAt = null;
  user.trialEndsAt = null;
  user.subscriptionEndsAt = addMonths(now, plan.durationMonths || 1);
};

export const getPlans = catchAsync(async (req, res) => {
  const plans = await getActivePlans();

  res.status(httpStatus.OK).json({
    success: true,
    data: plans,
  });
});

export const checkout = catchAsync(async (req, res) => {
  const planKey = req.body.planKey || req.user.selectedPlan;
  const paymentMethod = req.body.paymentMethod || "card";
  const paymentDetails = req.body.paymentDetails || {};

  if (!planKey) {
    throw new AppError("planKey is required.", httpStatus.BAD_REQUEST);
  }

  const plan = await getPlanByKey(planKey);
  if (!plan) {
    throw new AppError("Invalid planKey provided.", httpStatus.BAD_REQUEST);
  }

  const normalizedPaymentMethod = plan.price === 0 ? "manual" : paymentMethod;
  const paymentInput = validatePaymentInput(normalizedPaymentMethod, paymentDetails);

  const transactionId = `MOCK-${Date.now()}-${crypto.randomInt(1000, 10000)}`;

  const payment = await Payment.create({
    user: req.user._id,
    planKey: plan.key,
    planName: plan.name,
    amount: plan.price,
    currency: plan.currency || "USD",
    status: "succeeded",
    paymentMethod: normalizedPaymentMethod,
    transactionId,
    paidAt: new Date(),
    cardLast4: paymentInput.cardLast4 || "",
    cardBrand: paymentInput.cardBrand || "",
    metadata: paymentInput.metadata || {},
  });

  activateUserPlan(req.user, plan);
  await req.user.save({ validateBeforeSave: false });

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Payment completed successfully.",
    data: {
      payment: buildPaymentResponse(payment),
      user: serializeUser(req.user),
    },
  });
});

export const getMyPayments = catchAsync(async (req, res) => {
  const payments = await Payment.find({ user: req.user._id }).sort({ createdAt: -1 });

  res.status(httpStatus.OK).json({
    success: true,
    data: payments.map(buildPaymentResponse),
  });
});
