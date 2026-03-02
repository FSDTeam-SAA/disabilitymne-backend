import { Router } from "express";
import { protect, restrictTo } from "../middlewares/auth.js";
import { uploadImageFields } from "../middlewares/upload.js";
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
const uploadExerciseImages = uploadImageFields([
  { name: "exerciseImages", maxCount: 10 },
  { name: "exerciseImage", maxCount: 10 },
  { name: "image", maxCount: 10 },
  { name: "targetMuscleImages", maxCount: 10 },
  { name: "targetMuscleImage", maxCount: 10 },
  { name: "muscleImages", maxCount: 10 },
  { name: "muscleImage", maxCount: 10 },
]);

router.use(protect);

adminRouter.get("/premium-users", listPremiumUsersForExercises);
adminRouter.route("/").get(getAdminExercises).post(uploadExerciseImages, createExercise);
adminRouter.patch("/:exerciseId/visibility", updateExerciseVisibility);
adminRouter.route("/:exerciseId").get(getAdminExerciseById).patch(uploadExerciseImages, updateAdminExercise).delete(deleteAdminExercise);

router.use("/admin", restrictTo("admin"), adminRouter);

router.get("/library", getPublicExerciseLibrary);
router.get("/my", getMyPrivateExercises);
router.get("/all", getAllAccessibleExercises);
router.get("/:exerciseId", getExerciseByIdForUser);

export default router;
