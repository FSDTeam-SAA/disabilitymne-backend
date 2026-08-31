import { Router } from "express";
import {
  getMyPayments,
  getPlans,
  getPremiumAvailability,
  checkout,
  confirmCheckout,
  stripeWebhook,
  checkoutSuccessPage,
  checkoutCancelPage,
  verifyApplePurchase,
  restoreApplePurchases,
  appleServerNotification,
} from "../controllers/payment.controller.js";
import { protect } from "../middlewares/auth.js";
import {
  allSecureCallback,
  allSecureCancelPage,
  allSecureCheckout,
  allSecureErrorPage,
  allSecureSuccessPage,
  confirmAllSecureCheckout,
} from "../controllers/allsecurePayment.controller.js";

const router = Router();

router.get("/plans", getPlans);
router.get("/premium-availability", getPremiumAvailability);
router.post("/webhook", stripeWebhook);
router.post("/apple/notifications", appleServerNotification);
router.get("/checkout/success", checkoutSuccessPage);
router.get("/checkout/cancel", checkoutCancelPage);
router.post("/allsecure/callback", allSecureCallback);
router.get("/allsecure/success", allSecureSuccessPage);
router.get("/allsecure/cancel", allSecureCancelPage);
router.get("/allsecure/error", allSecureErrorPage);
router.use(protect);
router.get("/me", getMyPayments);
router.get("/premium-availability/me", getPremiumAvailability);
router.post("/checkout", checkout);
router.post("/checkout/confirm", confirmCheckout);
router.get("/checkout/confirm/:sessionId", confirmCheckout);
router.post("/allsecure/checkout", allSecureCheckout);
router.post("/allsecure/checkout/confirm", confirmAllSecureCheckout);
router.get("/allsecure/checkout/confirm/:sessionId", confirmAllSecureCheckout);
router.post("/apple/verify", verifyApplePurchase);
router.post("/apple/restore", restoreApplePurchases);

export default router;
