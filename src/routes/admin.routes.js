import { Router } from "express";
import { protect, restrictTo } from "../middlewares/auth.js";
import { uploadImageFields } from "../middlewares/upload.js";
import {
  createAdminUser,
  createAdminSubscriptionPlan,
  deleteAdminSubscriptionPlan,
  deleteAdminUser,
  getAdminSettingsProfile,
  getAdminSupportTicketById,
  getAdminSupportTickets,
  getAdminSubscriptionPlans,
  getAdminUsers,
  getAdminWorkoutProgress,
  getAdminWorkoutExperienceById,
  getAdminWorkoutExperiences,
  getDashboardOverview,
  updateAdminSupportTicket,
  updateAdminSettingsPassword,
  updateAdminSettingsProfile,
  updateAdminSubscriptionPlan,
  updateAdminUserStatus,
} from "../controllers/admin.controller.js";

const router = Router();
const uploadAdminProfileImage = uploadImageFields([
  { name: "profileImage", maxCount: 1 },
  { name: "avatar", maxCount: 1 },
  { name: "image", maxCount: 1 },
]);

router.use(protect, restrictTo("admin"));

router.get("/dashboard/overview", getDashboardOverview);

router.get("/users", getAdminUsers);
router.post("/users", createAdminUser);
router.patch("/users/:userId/status", updateAdminUserStatus);
router.delete("/users/:userId", deleteAdminUser);
router.get("/support/tickets", getAdminSupportTickets);
router.get("/support/tickets/:ticketId", getAdminSupportTicketById);
router.patch("/support/tickets/:ticketId", updateAdminSupportTicket);
router.get("/workout-progress", getAdminWorkoutProgress);
router.get("/workout-experiences", getAdminWorkoutExperiences);
router.get("/workout-experiences/:experienceId", getAdminWorkoutExperienceById);

router.get("/settings/profile", getAdminSettingsProfile);
router.patch("/settings/profile", uploadAdminProfileImage, updateAdminSettingsProfile);
router.patch("/settings/password", updateAdminSettingsPassword);

router.get("/subscriptions/plans", getAdminSubscriptionPlans);
router.post("/subscriptions/plans", createAdminSubscriptionPlan);
router.patch("/subscriptions/plans/:planKey", updateAdminSubscriptionPlan);
router.delete("/subscriptions/plans/:planKey", deleteAdminSubscriptionPlan);

export default router;
