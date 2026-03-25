import { Router } from "express";
import { protect } from "../middlewares/auth.js";
import {
  calculateMacroTargets,
  createNutritionDiaryEntry,
  deleteNutritionFavoriteMeal,
  deleteNutritionDiaryEntry,
  getNutritionDiary,
  getNutritionDiaryEntryById,
  getNutritionFavoriteSections,
  getNutritionFavorites,
  getNutritionHistory,
  getFoodByFdcId,
  getFoodSuggestions,
  saveNutritionFavoriteMeal,
  searchFoods,
  updateNutritionDiaryEntry,
} from "../controllers/nutrition.controller.js";

const router = Router();

router.use(protect);

router.post("/calculator/macro-targets", calculateMacroTargets);
router.get("/foods/search", searchFoods);
router.get("/foods/suggestions", getFoodSuggestions);
router.get("/foods/:fdcId", getFoodByFdcId);
router.get("/diary", getNutritionDiary);
router.get("/history", getNutritionHistory);
router.get("/favorites/sections", getNutritionFavoriteSections);
router.get("/favorites", getNutritionFavorites);
router.post("/favorites/meals", saveNutritionFavoriteMeal);
router.delete("/favorites/meals/:mealFavoriteId", deleteNutritionFavoriteMeal);
router.post("/diary/entries", createNutritionDiaryEntry);
router.get("/diary/entries/:entryId", getNutritionDiaryEntryById);
router.patch("/diary/entries/:entryId", updateNutritionDiaryEntry);
router.delete("/diary/entries/:entryId", deleteNutritionDiaryEntry);

export default router;
