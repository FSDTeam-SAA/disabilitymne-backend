import httpStatus from "http-status";
import crypto from "crypto";
import mongoose from "mongoose";
import Stripe from "stripe";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { Payment } from "../models/payment.model.js";
import { User } from "../models/user.model.js";
import { getPlanByKey as getStaticPlanByKey } from "../constants/subscriptionPlans.js";
import { getActivePlans, getPlanByKey as getDbPlanByKey } from "../services/subscriptionPlan.service.js";
import { sendEmail } from "../services/email.service.js";
import { buildPaymentReceiptEmail } from "../utils/emailTemplates.js";
import { serializeUser } from "../utils/serializeUser.js";
import { processApplePurchase, processAppleRestore } from "../services/appleIap.service.js";
import {
  assertPremiumCapacityAvailable,
  getPremiumCapacitySnapshot,
} from "../services/premiumCapacity.service.js";

const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);
const STRIPE_SUCCESS_PAYMENT_STATUSES = new Set(["paid", "no_payment_required"]);

let stripeClient = null;

const getStripeClient = () => {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!secretKey) {
    throw new AppError("Stripe is not configured. Set STRIPE_SECRET_KEY.", httpStatus.INTERNAL_SERVER_ERROR);
  }

  if (!stripeClient) {
    stripeClient = new Stripe(secretKey);
  }

  return stripeClient;
};

const addMonths = (date, months) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
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

const normalizeUrl = (value) => String(value || "").trim();

const ensureStripeWebhookConfigured = () => {
  const webhookSecret = normalizeUrl(process.env.STRIPE_WEBHOOK_SECRET);
  if (!webhookSecret) {
    throw new AppError(
      "Stripe webhook mode is enabled but STRIPE_WEBHOOK_SECRET is not configured.",
      httpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

const resolveBackendBaseUrl = () =>
  normalizeUrl(
    process.env.BACKEND_PUBLIC_URL ||
      process.env.BACKEND_URL ||
      process.env.API_BASE_URL ||
      process.env.APP_BASE_URL ||
      process.env.FRONTEND_URL ||
      "http://localhost:8000"
  );

const buildDefaultRedirectUrl = (type) => {
  const explicit = normalizeUrl(type === "success" ? process.env.PAYMENT_SUCCESS_URL : process.env.PAYMENT_CANCEL_URL);
  if (explicit) return explicit;

  const backendBase = resolveBackendBaseUrl();
  return `${backendBase.replace(/\/+$/, "")}/api/v1/payments/checkout/${type}`;
};

const resolveRedirectUrl = (type) => {
  const candidate = buildDefaultRedirectUrl(type);

  try {
    return new URL(candidate).toString();
  } catch {
    throw new AppError(`${type} redirect URL must be a valid absolute URL.`, httpStatus.INTERNAL_SERVER_ERROR);
  }
};

const withCheckoutSessionPlaceholder = (successUrl) =>
  successUrl.includes("{CHECKOUT_SESSION_ID}")
    ? successUrl
    : `${successUrl}${successUrl.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`;

const toMinorUnits = (amount, currency) => {
  const normalizedCurrency = String(currency || "usd").toLowerCase();
  if (ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency)) {
    return Math.max(0, Math.round(amount));
  }

  return Math.max(0, Math.round(Number(amount || 0) * 100));
};

const resolvePlanForActivation = async (planKey) => {
  const planFromDb = await getDbPlanByKey(planKey);
  if (planFromDb) return planFromDb;
  return getStaticPlanByKey(planKey) || null;
};

const activateUserPlan = (user, plan, startedAt = new Date()) => {
  const now = new Date(startedAt);

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
    console.error(`[payments] Failed to send payment receipt email: ${error.message}`);
  }
};

const completeFreePlanCheckout = async ({ user, plan }) => {
  const payment = await Payment.create({
    user: user._id,
    planKey: plan.key,
    planName: plan.name,
    amount: plan.price,
    currency: String(plan.currency || "USD").toUpperCase(),
    status: "succeeded",
    paymentMethod: "manual",
    provider: "internal",
    transactionId: `MANUAL-${Date.now()}-${crypto.randomInt(1000, 10000)}`,
    paidAt: new Date(),
    metadata: {},
  });

  activateUserPlan(user, plan, payment.paidAt);
  await user.save({ validateBeforeSave: false });
  await sendPaymentReceipt({ payment, user });

  return payment;
};

const findPaymentByStripeSession = async (session) => {
  const paymentId = session?.metadata?.paymentId;

  if (paymentId && mongoose.isValidObjectId(paymentId)) {
    const payment = await Payment.findById(paymentId);
    if (payment) return payment;
  }

  const sessionId = String(session?.id || "").trim();
  if (!sessionId) return null;

  return Payment.findOne({ provider: "stripe", transactionId: sessionId });
};

const assertSessionBelongsToUser = ({ session, payment, userId }) => {
  const expectedUserId = String(userId || "");
  const sessionMetadataUserId = String(session?.metadata?.userId || "").trim();
  const sessionClientReferenceId = String(session?.client_reference_id || "").trim();

  if (payment && String(payment.user) !== expectedUserId) {
    throw new AppError("You are not allowed to access this payment session.", httpStatus.FORBIDDEN);
  }

  if (sessionMetadataUserId && sessionMetadataUserId !== expectedUserId) {
    throw new AppError("You are not allowed to access this payment session.", httpStatus.FORBIDDEN);
  }

  if (sessionClientReferenceId && sessionClientReferenceId !== expectedUserId) {
    throw new AppError("You are not allowed to access this payment session.", httpStatus.FORBIDDEN);
  }
};

const activatePlanForPayment = async (payment) => {
  const user = await User.findById(payment.user);
  if (!user || !user.isActive) {
    return;
  }

  const plan = await resolvePlanForActivation(payment.planKey);
  if (!plan) {
    throw new AppError(`Unable to resolve subscription plan "${payment.planKey}" for activation.`, httpStatus.BAD_REQUEST);
  }

  await assertPremiumCapacityAvailable({ user, planKey: plan.key });

  activateUserPlan(user, plan, payment.paidAt || new Date());
  await user.save({ validateBeforeSave: false });
  await sendPaymentReceipt({ payment, user });
};

const markStripePaymentFailed = async (payment, reason, extraMetadata = {}) => {
  if (!payment || payment.status === "succeeded") return;

  payment.status = "failed";
  payment.failureReason = String(reason || "Stripe payment failed.").slice(0, 180);
  payment.metadata = {
    ...(payment.metadata || {}),
    ...extraMetadata,
  };

  await payment.save({ validateBeforeSave: false });
};

const handleStripeCheckoutCompleted = async (session) => {
  const payment = await findPaymentByStripeSession(session);
  if (!payment) return;
  if (payment.status === "succeeded") return;

  const stripe = getStripeClient();

  let cardBrand = "";
  let cardLast4 = "";
  const paymentIntentId = String(session?.payment_intent || "").trim();

  if (paymentIntentId) {
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      const chargeId = paymentIntent?.latest_charge ? String(paymentIntent.latest_charge) : "";

      if (chargeId) {
        const charge = await stripe.charges.retrieve(chargeId);
        cardBrand = String(charge?.payment_method_details?.card?.brand || "").trim();
        cardLast4 = String(charge?.payment_method_details?.card?.last4 || "").trim();
      }
    } catch (error) {
      console.error(`[payments] Failed to fetch Stripe charge details: ${error.message}`);
    }
  }

  payment.status = "succeeded";
  payment.paidAt = new Date();
  payment.failureReason = "";
  payment.cardBrand = cardBrand || payment.cardBrand;
  payment.cardLast4 = cardLast4 || payment.cardLast4;
  payment.metadata = {
    ...(payment.metadata || {}),
    stripeSessionId: session.id,
    stripePaymentIntentId: paymentIntentId || payment.metadata?.stripePaymentIntentId || "",
    stripePaymentStatus: String(session?.payment_status || "paid"),
  };

  await payment.save({ validateBeforeSave: false });
  await activatePlanForPayment(payment);
};

const handleStripeCheckoutFailed = async (session, reason) => {
  const payment = await findPaymentByStripeSession(session);
  if (!payment) return;

  await markStripePaymentFailed(payment, reason, {
    stripeSessionId: session.id,
    stripePaymentStatus: String(session?.payment_status || "unpaid"),
  });
};

const getStripeCheckoutSession = async (sessionId) => {
  const stripe = getStripeClient();

  try {
    return await stripe.checkout.sessions.retrieve(sessionId);
  } catch (error) {
    if (error?.statusCode === 404 || error?.code === "resource_missing") {
      throw new AppError("Invalid or unknown Stripe checkout session.", httpStatus.BAD_REQUEST);
    }

    throw error;
  }
};

const syncPaymentFromStripeSession = async (session) => {
  const stripeSessionStatus = String(session?.status || "").toLowerCase();
  const stripePaymentStatus = String(session?.payment_status || "").toLowerCase();

  if (STRIPE_SUCCESS_PAYMENT_STATUSES.has(stripePaymentStatus)) {
    await handleStripeCheckoutCompleted(session);
    return "succeeded";
  }

  if (stripeSessionStatus === "expired") {
    await handleStripeCheckoutFailed(session, "Stripe checkout session expired.");
    return "failed";
  }

  if (stripeSessionStatus === "complete" && stripePaymentStatus === "unpaid") {
    await handleStripeCheckoutFailed(session, "Stripe checkout finished but payment remains unpaid.");
    return "failed";
  }

  return "pending";
};

export const getPlans = catchAsync(async (req, res) => {
  const plans = await getActivePlans();

  res.status(httpStatus.OK).json({
    success: true,
    data: plans,
  });
});

export const getPremiumAvailability = catchAsync(async (req, res) => {
  const snapshot = await getPremiumCapacitySnapshot({
    excludeUserId: req.user?._id || null,
  });

  res.status(httpStatus.OK).json({
    success: true,
    data: snapshot,
  });
});

export const checkout = catchAsync(async (req, res) => {
  const planKey = req.body.planKey || req.user.selectedPlan;

  if (!planKey) {
    throw new AppError("planKey is required.", httpStatus.BAD_REQUEST);
  }

  const plan = await getDbPlanByKey(planKey);
  if (!plan) {
    throw new AppError("Invalid planKey provided.", httpStatus.BAD_REQUEST);
  }

  await assertPremiumCapacityAvailable({ user: req.user, planKey: plan.key });

  if (Number(plan.price || 0) <= 0) {
    const payment = await completeFreePlanCheckout({ user: req.user, plan });

    return res.status(httpStatus.CREATED).json({
      success: true,
      message: "Plan activated successfully.",
      data: {
        payment: buildPaymentResponse(payment),
        user: serializeUser(req.user),
      },
    });
  }

  ensureStripeWebhookConfigured();

  const stripe = getStripeClient();
  const successUrl = withCheckoutSessionPlaceholder(resolveRedirectUrl("success"));
  const cancelUrl = resolveRedirectUrl("cancel");
  const currency = String(plan.currency || "USD").toLowerCase();
  const amountMinor = toMinorUnits(plan.price, currency);

  const payment = await Payment.create({
    user: req.user._id,
    planKey: plan.key,
    planName: plan.name,
    amount: plan.price,
    currency: String(plan.currency || "USD").toUpperCase(),
    status: "pending",
    paymentMethod: "card",
    provider: "stripe",
    transactionId: "",
    metadata: {
      source: "stripe_checkout",
    },
  });

  const metadata = {
    paymentId: payment._id.toString(),
    planKey: plan.key,
    userId: req.user._id.toString(),
  };

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: req.user.email,
    client_reference_id: req.user._id.toString(),
    metadata,
    payment_intent_data: {
      metadata,
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amountMinor,
          product_data: {
            name: plan.name,
            description: plan.durationLabel || `Subscription plan: ${plan.key}`,
          },
        },
      },
    ],
  });

  payment.transactionId = session.id;
  payment.metadata = {
    ...(payment.metadata || {}),
    stripeSessionId: session.id,
    stripePaymentStatus: String(session.payment_status || "unpaid"),
  };
  await payment.save({ validateBeforeSave: false });

  return res.status(httpStatus.CREATED).json({
    success: true,
    message: "Stripe checkout session created successfully.",
    data: {
      checkoutUrl: session.url,
      sessionId: session.id,
      payment: buildPaymentResponse(payment),
      user: serializeUser(req.user),
    },
  });
});

const checkoutRedirectPage = ({ title, message }) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f6f8fa;
      color: #111827;
      padding: 24px;
    }
    .card {
      max-width: 560px;
      width: 100%;
      background: #ffffff;
      border-radius: 14px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.08);
      padding: 24px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 22px;
    }
    p {
      margin: 0;
      line-height: 1.6;
      color: #374151;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;

export const checkoutSuccessPage = (req, res) => {
  res
    .status(httpStatus.OK)
    .type("html")
    .send(
      checkoutRedirectPage({
        title: "Payment processed",
        message: "Your payment was received. You can return to the app now.",
      })
    );
};

export const checkoutCancelPage = (req, res) => {
  res
    .status(httpStatus.OK)
    .type("html")
    .send(
      checkoutRedirectPage({
        title: "Payment canceled",
        message: "No charge was completed. You can return to the app and try again anytime.",
      })
    );
};

export const getMyPayments = catchAsync(async (req, res) => {
  const payments = await Payment.find({ user: req.user._id }).sort({ createdAt: -1 });

  res.status(httpStatus.OK).json({
    success: true,
    data: payments.map(buildPaymentResponse),
  });
});

export const confirmCheckout = catchAsync(async (req, res) => {
  const sessionId = String(req.body.sessionId || req.params.sessionId || req.query.sessionId || req.query.session_id || "").trim();

  if (!sessionId) {
    throw new AppError("sessionId is required.", httpStatus.BAD_REQUEST);
  }

  const session = await getStripeCheckoutSession(sessionId);
  const payment = await findPaymentByStripeSession(session);

  if (!payment) {
    throw new AppError("No payment record found for the provided checkout session.", httpStatus.NOT_FOUND);
  }

  assertSessionBelongsToUser({
    session,
    payment,
    userId: req.user._id,
  });

  await syncPaymentFromStripeSession(session);

  const [freshPayment, freshUser] = await Promise.all([Payment.findById(payment._id), User.findById(req.user._id)]);

  return res.status(httpStatus.OK).json({
    success: true,
    message: "Checkout session status synchronized.",
    data: {
      sessionId: session.id,
      stripeSessionStatus: String(session?.status || ""),
      stripePaymentStatus: String(session?.payment_status || ""),
      payment: freshPayment ? buildPaymentResponse(freshPayment) : null,
      user: freshUser ? serializeUser(freshUser) : null,
    },
  });
});

export const stripeWebhook = async (req, res) => {
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!webhookSecret) {
    return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: "STRIPE_WEBHOOK_SECRET is not configured.",
    });
  }

  const signature = req.headers["stripe-signature"];
  if (!signature) {
    return res.status(httpStatus.BAD_REQUEST).json({
      success: false,
      message: "Missing stripe-signature header.",
    });
  }

  let event;

  try {
    const stripe = getStripeClient();
    const payload = req.rawBody || JSON.stringify(req.body || {});
    event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (error) {
    return res.status(httpStatus.BAD_REQUEST).json({
      success: false,
      message: `Stripe webhook signature verification failed: ${error.message}`,
    });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        await handleStripeCheckoutCompleted(event.data.object);
        break;
      case "checkout.session.async_payment_failed":
        await handleStripeCheckoutFailed(event.data.object, "Stripe async payment failed.");
        break;
      case "checkout.session.expired":
        await handleStripeCheckoutFailed(event.data.object, "Stripe checkout session expired.");
        break;
      case "payment_intent.payment_failed": {
        const paymentIntent = event.data.object;
        const paymentId = paymentIntent?.metadata?.paymentId;

        if (paymentId && mongoose.isValidObjectId(paymentId)) {
          const payment = await Payment.findById(paymentId);
          if (payment) {
            await markStripePaymentFailed(payment, paymentIntent?.last_payment_error?.message || "Payment intent failed.", {
              stripePaymentIntentId: paymentIntent.id,
            });
          }
        }
        break;
      }
      default:
        break;
    }

    return res.status(httpStatus.OK).json({ received: true });
  } catch (error) {
    console.error(`[payments] Stripe webhook handler error: ${error.message}`);
    return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      message: "Failed to process Stripe webhook event.",
    });
  }
};

export const verifyApplePurchase = catchAsync(async (req, res) => {
  const receiptData = String(req.body?.receiptData || req.body?.receipt || "").trim();
  const planKey = String(req.body?.planKey || "").trim().toLowerCase();
  const productId = String(req.body?.productId || "").trim();
  const transactionId = String(req.body?.transactionId || "").trim();

  const { payment, user } = await processApplePurchase({
    userId: req.user._id,
    receiptData,
    planKey,
    productId,
    transactionId,
  });

  res.status(httpStatus.OK).json({
    success: true,
    message: "Apple purchase verified successfully.",
    data: {
      payment: buildPaymentResponse(payment),
      user: serializeUser(user),
    },
  });
});

export const restoreApplePurchases = catchAsync(async (req, res) => {
  const receiptData = String(req.body?.receiptData || req.body?.receipt || "").trim();

  const { payment, user } = await processAppleRestore({
    userId: req.user._id,
    receiptData,
  });

  res.status(httpStatus.OK).json({
    success: true,
    message: "Apple purchases restored successfully.",
    data: {
      payment: buildPaymentResponse(payment),
      user: serializeUser(user),
    },
  });
});
