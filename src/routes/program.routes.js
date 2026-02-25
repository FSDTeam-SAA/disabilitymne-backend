import { Router } from "express";
import { protect, restrictTo } from "../middlewares/auth.js";
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
  updateAdminProgram,
} from "../controllers/program.controller.js";

const router = Router();
const adminRouter = Router();

router.use(protect);

adminRouter.get("/premium-users", listPremiumUsers);
adminRouter.route("/").get(getAdminPrograms).post(createProgram);
adminRouter.route("/:programId").get(getAdminProgramById).patch(updateAdminProgram).delete(deleteAdminProgram);

router.use("/admin", restrictTo("admin"), adminRouter);

router.get("/explore", getExplorePrograms);
router.get("/my", getMyPrograms);
router.get("/all", getAllAccessiblePrograms);
router.get("/:programId", getProgramByIdForUser);

export default router;
