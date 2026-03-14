import { Router } from "express";
import { protect, restrictTo } from "../middlewares/auth.js";
import {
  createOrGetChatThread,
  getChatMessages,
  getPremiumUsersForChat,
  listChatThreads,
  markChatThreadAsRead,
  sendChatMessage,
} from "../controllers/chat.controller.js";

const router = Router();

router.use(protect);

router.get("/threads", listChatThreads);
router.post("/threads", createOrGetChatThread);
router.get("/threads/:threadId/messages", getChatMessages);
router.post("/threads/:threadId/messages", sendChatMessage);
router.patch("/threads/:threadId/read", markChatThreadAsRead);

router.get("/admin/premium-users", restrictTo("admin"), getPremiumUsersForChat);

export default router;
