import mongoose from "mongoose";
import { Payment } from "../models/payment.model.js";
import { WorkoutLog } from "../models/workoutLog.model.js";
import { WorkoutSession } from "../models/workoutSession.model.js";
import { WorkoutExperience } from "../models/workoutExperience.model.js";
import { WeightLog } from "../models/weightLog.model.js";
import { UserProgram } from "../models/userProgram.model.js";
import { UserExerciseSetting } from "../models/userExerciseSetting.model.js";
import { SupportTicket } from "../models/supportTicket.model.js";
import { NutritionEntry } from "../models/nutritionEntry.model.js";
import { Notification } from "../models/notification.model.js";
import { DailyTracker } from "../models/dailyTracker.model.js";
import { ChatThread } from "../models/chatThread.model.js";
import { ChatMessage } from "../models/chatMessage.model.js";

export const deleteAllUserData = async (userId) => {
  const userObjectId = new mongoose.Types.ObjectId(userId);

  const threads = await ChatThread.find({
    $or: [{ premiumUser: userObjectId }, { admin: userObjectId }, { createdBy: userObjectId }],
  }).select("_id");

  const threadIds = threads.map((thread) => thread._id);

  await Promise.all([
    Payment.deleteMany({ user: userObjectId }),
    WorkoutLog.deleteMany({ user: userObjectId }),
    WorkoutSession.deleteMany({ user: userObjectId }),
    WorkoutExperience.deleteMany({ user: userObjectId }),
    WeightLog.deleteMany({ user: userObjectId }),
    UserProgram.deleteMany({ user: userObjectId }),
    UserExerciseSetting.deleteMany({ user: userObjectId }),
    SupportTicket.deleteMany({ user: userObjectId }),
    NutritionEntry.deleteMany({ user: userObjectId }),
    Notification.deleteMany({ user: userObjectId }),
    DailyTracker.deleteMany({ user: userObjectId }),
    threadIds.length > 0
      ? ChatMessage.deleteMany({
          $or: [
            { thread: { $in: threadIds } },
            { sender: userObjectId },
            { recipient: userObjectId },
          ],
        })
      : ChatMessage.deleteMany({
          $or: [{ sender: userObjectId }, { recipient: userObjectId }],
        }),
    ChatThread.deleteMany({
      $or: [{ premiumUser: userObjectId }, { admin: userObjectId }, { createdBy: userObjectId }],
    }),
  ]);
};
