import { Router } from "express";
import { uploadImage } from "../middlewares/upload.js";
import { uploadSingleImage } from "../controllers/upload.controller.js";

const router = Router();

// Single image upload
router.post("/image", uploadImage.single("file"), uploadSingleImage);

export default router;
