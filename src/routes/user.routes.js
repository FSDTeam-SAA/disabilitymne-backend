import { Router } from "express";
import { protect } from "../middlewares/auth.js";
import { getMe, selectPlan, updateMe, updateOnboarding } from "../controllers/user.controller.js";

const router = Router();

router.use(protect);

router.get("/me", getMe);
router.patch("/me", updateMe);
router.patch("/me/onboarding", updateOnboarding);
router.post("/me/select-plan", selectPlan);

export default router;
