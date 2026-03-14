import { Router } from "express";
import { getMyPayments, getPlans, checkout, stripeWebhook } from "../controllers/payment.controller.js";
import { protect } from "../middlewares/auth.js";

const router = Router();

router.get("/plans", getPlans);
router.post("/webhook", stripeWebhook);
router.use(protect);
router.get("/me", getMyPayments);
router.post("/checkout", checkout);

export default router;
