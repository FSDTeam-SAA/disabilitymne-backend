import { Router } from "express";
import { uploadImage, uploadVideo } from "../middlewares/upload.js";
import { uploadSingleImage, uploadSingleVideo } from "../controllers/upload.controller.js";

const router = Router();

// Single image upload
router.post("/image", uploadImage.single("file"), uploadSingleImage);
router.post("/video", uploadVideo.single("file"), uploadSingleVideo);

export default router;
