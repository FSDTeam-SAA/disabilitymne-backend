import { Router } from "express";
import {
  login,
  logout,
  refreshAccessToken,
  register,
  resetPassword,
  sendPasswordResetOtp,
  verifyPasswordResetOtp,
} from "../controllers/auth.controller.js";
import { protect } from "../middlewares/auth.js";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/refresh-token", refreshAccessToken);
router.post("/logout", protect, logout);
router.post("/forgot-password/send-otp", sendPasswordResetOtp);
router.post("/forgot-password/verify-otp", verifyPasswordResetOtp);
router.post("/forgot-password/reset", resetPassword);

export default router;
