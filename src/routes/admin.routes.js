import { Router } from "express";
import { protect, restrictTo } from "../middlewares/auth.js";
import {
  createAdminSubscriptionPlan,
  deleteAdminSubscriptionPlan,
  deleteAdminUser,
  getAdminSettingsProfile,
  getAdminSubscriptionPlans,
  getAdminUsers,
  getDashboardOverview,
  updateAdminSettingsPassword,
  updateAdminSettingsProfile,
  updateAdminSubscriptionPlan,
  updateAdminUserStatus,
} from "../controllers/admin.controller.js";

const router = Router();

router.use(protect, restrictTo("admin"));

router.get("/dashboard/overview", getDashboardOverview);

router.get("/users", getAdminUsers);
router.patch("/users/:userId/status", updateAdminUserStatus);
router.delete("/users/:userId", deleteAdminUser);

router.get("/settings/profile", getAdminSettingsProfile);
router.patch("/settings/profile", updateAdminSettingsProfile);
router.patch("/settings/password", updateAdminSettingsPassword);

router.get("/subscriptions/plans", getAdminSubscriptionPlans);
router.post("/subscriptions/plans", createAdminSubscriptionPlan);
router.patch("/subscriptions/plans/:planKey", updateAdminSubscriptionPlan);
router.delete("/subscriptions/plans/:planKey", deleteAdminSubscriptionPlan);

export default router;
