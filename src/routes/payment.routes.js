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
} from "../controllers/payment.controller.js";
import { protect } from "../middlewares/auth.js";

const router = Router();

router.get("/plans", getPlans);
router.get("/premium-availability", getPremiumAvailability);
router.post("/webhook", stripeWebhook);
router.get("/checkout/success", checkoutSuccessPage);
router.get("/checkout/cancel", checkoutCancelPage);
router.use(protect);
router.get("/me", getMyPayments);
router.get("/premium-availability/me", getPremiumAvailability);
router.post("/checkout", checkout);
router.post("/checkout/confirm", confirmCheckout);
router.get("/checkout/confirm/:sessionId", confirmCheckout);
router.post("/apple/verify", verifyApplePurchase);
router.post("/apple/restore", restoreApplePurchases);

export default router;
