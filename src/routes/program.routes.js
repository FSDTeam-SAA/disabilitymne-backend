import { Router } from "express";
import { protect, restrictTo } from "../middlewares/auth.js";
import { uploadImageFields } from "../middlewares/upload.js";
import {
  createProgram,
  deleteAdminProgram,
  getAdminProgramById,
  getAdminPrograms,
  getAllAccessiblePrograms,
  getExplorePrograms,
  getMyPrograms,
  getProgramByIdForUser,
  listPremiumUsers,
  startProgramForUser,
  updateAdminProgram,
} from "../controllers/program.controller.js";

const router = Router();
const adminRouter = Router();
const uploadProgramImages = uploadImageFields([
  { name: "programImages", maxCount: 10 },
  { name: "programImage", maxCount: 10 },
  { name: "coverImage", maxCount: 10 },
  { name: "programThumbnails", maxCount: 10 },
  { name: "programThumbnail", maxCount: 10 },
  { name: "thumbnailImage", maxCount: 10 },
]);

router.use(protect);

adminRouter.get("/premium-users", listPremiumUsers);
adminRouter.route("/").get(getAdminPrograms).post(uploadProgramImages, createProgram);
adminRouter.route("/:programId").get(getAdminProgramById).patch(uploadProgramImages, updateAdminProgram).delete(deleteAdminProgram);

router.use("/admin", restrictTo("admin"), adminRouter);

router.get("/explore", getExplorePrograms);
router.get("/my", getMyPrograms);
router.get("/all", getAllAccessiblePrograms);
router.post("/:programId/start", startProgramForUser);
router.get("/:programId", getProgramByIdForUser);

export default router;
