import { Router } from "express";
import { protect, restrictTo } from "../middlewares/auth.js";
import { uploadImageFields } from "../middlewares/upload.js";
import {
  createHomeBanners,
  deleteHomeBanner,
  getAdminHomeBanners,
  getHomeBanners,
  reorderHomeBanners,
  updateHomeBanner,
} from "../controllers/homeBanner.controller.js";

const router = Router();
const adminRouter = Router();
const uploadHomeBannerImages = uploadImageFields([
  { name: "images", maxCount: 20 },
  { name: "image", maxCount: 20 },
  { name: "files", maxCount: 20 },
]);

adminRouter.route("/").get(getAdminHomeBanners).post(uploadHomeBannerImages, createHomeBanners);
adminRouter.patch("/reorder", reorderHomeBanners);
adminRouter.route("/:bannerId").patch(updateHomeBanner).delete(deleteHomeBanner);

router.get("/", getHomeBanners);
router.use("/admin", protect, restrictTo("admin"), adminRouter);

export default router;
