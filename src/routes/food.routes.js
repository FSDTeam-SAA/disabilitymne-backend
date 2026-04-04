import { Router } from "express";
import { protect } from "../middlewares/auth.js";
import { getFoodByFdcId, getFoodSuggestions, searchFoods } from "../controllers/nutrition.controller.js";

const router = Router();

router.use(protect);
router.get("/search", searchFoods);
router.get("/suggestions", getFoodSuggestions);
router.get("/:fdcId", getFoodByFdcId);

export default router;
