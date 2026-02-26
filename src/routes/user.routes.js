import { Router } from "express";
import { protect } from "../middlewares/auth.js";
import { getMe, selectPlan, updateMe, updateOnboarding } from "../controllers/user.controller.js";
import {
  addDailyTrackerNote,
  changeMyPassword,
  createSupportTicket,
  createWorkoutLog,
  getDailyTracker,
  getHomeOverview,
  getLanguagePreference,
  getMyPublicProfile,
  getMySupportTickets,
  getNotificationList,
  getProgressOverview,
  getWorkoutLogs,
  markAllNotificationsRead,
  markNotificationRead,
  updateDailyTracker,
  updateLanguagePreference,
} from "../controllers/userExperience.controller.js";

const router = Router();

router.use(protect);

router.get("/me", getMe);
router.patch("/me", updateMe);
router.patch("/me/onboarding", updateOnboarding);
router.post("/me/select-plan", selectPlan);
router.get("/me/home", getHomeOverview);
router.get("/me/profile", getMyPublicProfile);
router.get("/me/progress", getProgressOverview);
router.get("/me/daily-tracker", getDailyTracker);
router.patch("/me/daily-tracker", updateDailyTracker);
router.post("/me/daily-tracker/notes", addDailyTrackerNote);
router.post("/me/workouts/logs", createWorkoutLog);
router.get("/me/workouts/logs", getWorkoutLogs);
router.get("/me/notifications", getNotificationList);
router.patch("/me/notifications/read-all", markAllNotificationsRead);
router.patch("/me/notifications/:notificationId/read", markNotificationRead);
router.get("/me/language", getLanguagePreference);
router.patch("/me/language", updateLanguagePreference);
router.post("/me/support/tickets", createSupportTicket);
router.get("/me/support/tickets", getMySupportTickets);
router.post("/me/change-password", changeMyPassword);

export default router;
