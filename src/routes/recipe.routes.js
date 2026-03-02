import { Router } from "express";
import { protect, restrictTo } from "../middlewares/auth.js";
import { uploadImageFields } from "../middlewares/upload.js";
import {
  createRecipe,
  deleteAdminRecipe,
  getAdminRecipeById,
  getAdminRecipes,
  getAllAccessibleRecipes,
  getExploreRecipes,
  getMyRecipes,
  getRecipeByIdForUser,
  listPremiumUsersForRecipes,
  updateAdminRecipe,
} from "../controllers/recipe.controller.js";

const router = Router();
const adminRouter = Router();
const uploadRecipeImages = uploadImageFields([
  { name: "recipeImages", maxCount: 10 },
  { name: "recipeImage", maxCount: 10 },
  { name: "image", maxCount: 10 },
]);

router.use(protect);

adminRouter.get("/premium-users", listPremiumUsersForRecipes);
adminRouter.route("/").get(getAdminRecipes).post(uploadRecipeImages, createRecipe);
adminRouter.route("/:recipeId").get(getAdminRecipeById).patch(uploadRecipeImages, updateAdminRecipe).delete(deleteAdminRecipe);

router.use("/admin", restrictTo("admin"), adminRouter);

router.get("/explore", getExploreRecipes);
router.get("/my", getMyRecipes);
router.get("/all", getAllAccessibleRecipes);
router.get("/:recipeId", getRecipeByIdForUser);

export default router;
