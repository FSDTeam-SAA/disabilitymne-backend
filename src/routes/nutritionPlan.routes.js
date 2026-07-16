import { Router } from "express";
import { protect, restrictTo } from "../middlewares/auth.js";
import {
  createNutritionPlan,
  deleteAdminNutritionPlan,
  duplicateAdminNutritionPlan,
  assignNutritionPlanToPremiumUser,
  getAdminNutritionPlanById,
  getAdminNutritionPlans,
  getMyNutritionPlans,
  getNutritionPlanByIdForUser,
  listPremiumUsersForNutritionPlans,
  updateAdminNutritionPlan,
} from "../controllers/nutritionPlan.controller.js";

const router = Router();
const adminRouter = Router();

router.use(protect);

adminRouter.get("/premium-users", listPremiumUsersForNutritionPlans);
adminRouter.route("/").get(getAdminNutritionPlans).post(createNutritionPlan);
adminRouter.post("/:planId/assign", assignNutritionPlanToPremiumUser);
adminRouter.post("/:planId/duplicate", duplicateAdminNutritionPlan);
adminRouter
  .route("/:planId")
  .get(getAdminNutritionPlanById)
  .patch(updateAdminNutritionPlan)
  .delete(deleteAdminNutritionPlan);

router.use("/admin", restrictTo("admin"), adminRouter);

router.get("/my", getMyNutritionPlans);
router.get("/:planId", getNutritionPlanByIdForUser);

export default router;
