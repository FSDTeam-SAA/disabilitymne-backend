import { Router } from "express";
import { protect, restrictTo } from "../middlewares/auth.js";
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

router.use(protect);

adminRouter.get("/premium-users", listPremiumUsersForRecipes);
adminRouter.route("/").get(getAdminRecipes).post(createRecipe);
adminRouter.route("/:recipeId").get(getAdminRecipeById).patch(updateAdminRecipe).delete(deleteAdminRecipe);

router.use("/admin", restrictTo("admin"), adminRouter);

router.get("/explore", getExploreRecipes);
router.get("/my", getMyRecipes);
router.get("/all", getAllAccessibleRecipes);
router.get("/:recipeId", getRecipeByIdForUser);

export default router;
