import { Router } from "express";
import { protect, restrictTo } from "../middlewares/auth.js";
import {
  createExercise,
  deleteAdminExercise,
  getAdminExerciseById,
  getAdminExercises,
  getAllAccessibleExercises,
  getExerciseByIdForUser,
  getMyPrivateExercises,
  getPublicExerciseLibrary,
  listPremiumUsersForExercises,
  updateAdminExercise,
  updateExerciseVisibility,
} from "../controllers/exercise.controller.js";

const router = Router();
const adminRouter = Router();

router.use(protect);

adminRouter.get("/premium-users", listPremiumUsersForExercises);
adminRouter.route("/").get(getAdminExercises).post(createExercise);
adminRouter.patch("/:exerciseId/visibility", updateExerciseVisibility);
adminRouter.route("/:exerciseId").get(getAdminExerciseById).patch(updateAdminExercise).delete(deleteAdminExercise);

router.use("/admin", restrictTo("admin"), adminRouter);

router.get("/library", getPublicExerciseLibrary);
router.get("/my", getMyPrivateExercises);
router.get("/all", getAllAccessibleExercises);
router.get("/:exerciseId", getExerciseByIdForUser);

export default router;
