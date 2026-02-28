import { Router } from "express";
import { protect } from "../middlewares/auth.js";
import {
  calculateMacroTargets,
  getFoodByFdcId,
  getFoodSuggestions,
  searchFoods,
} from "../controllers/nutrition.controller.js";

const router = Router();

router.use(protect);

router.post("/calculator/macro-targets", calculateMacroTargets);
router.get("/foods/search", searchFoods);
router.get("/foods/suggestions", getFoodSuggestions);
router.get("/foods/:fdcId", getFoodByFdcId);

export default router;
