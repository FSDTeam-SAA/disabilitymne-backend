import { Router } from "express";
import { protect, restrictTo } from "../middlewares/auth.js";
import { requireActiveSubscription } from "../middlewares/requireActiveSubscription.js";
import { uploadImageFields } from "../middlewares/upload.js";
import {
  createRecipe,
  deleteAdminRecipe,
  getAdminRecipeById,
  getAdminRecipes,
  getAllAccessibleRecipes,
  getExploreRecipes,
  getMyRecipes,
  getPublicRecipeById,
  getPublicRecipes,
  getRecipeByIdForUser,
  listPremiumUsersForRecipes,
  toggleRecipeFavorite,
  updateAdminRecipe,
} from "../controllers/recipe.controller.js";

const router = Router();
const adminRouter = Router();
const uploadRecipeImages = uploadImageFields([
  { name: "recipeImages", maxCount: 10 },
  { name: "recipeImage", maxCount: 10 },
  { name: "image", maxCount: 10 },
]);

// Public guest routes — no authentication required (normal_user recipes only).
router.get("/public/all", getPublicRecipes);
router.get("/public/:recipeId", getPublicRecipeById);

router.use(protect);

adminRouter.get("/premium-users", listPremiumUsersForRecipes);
adminRouter.route("/").get(getAdminRecipes).post(uploadRecipeImages, createRecipe);
adminRouter.route("/:recipeId").get(getAdminRecipeById).patch(uploadRecipeImages, updateAdminRecipe).delete(deleteAdminRecipe);

router.use("/admin", restrictTo("admin"), adminRouter);
router.use(requireActiveSubscription);

router.get("/explore", getExploreRecipes);
router.get("/my", getMyRecipes);
router.get("/all", getAllAccessibleRecipes);
router.patch("/:recipeId/favorite", toggleRecipeFavorite);
router.get("/:recipeId", getRecipeByIdForUser);

export default router;
