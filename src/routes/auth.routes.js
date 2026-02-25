import { Router } from "express";
import {
  login,
  register,
  resetPassword,
  sendPasswordResetOtp,
  verifyPasswordResetOtp,
} from "../controllers/auth.controller.js";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/forgot-password/send-otp", sendPasswordResetOtp);
router.post("/forgot-password/verify-otp", verifyPasswordResetOtp);
router.post("/forgot-password/reset", resetPassword);

export default router;
