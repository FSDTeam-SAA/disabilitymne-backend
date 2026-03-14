import mongoose from "mongoose";
import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { isPremiumActiveUser } from "../utils/access.js";
import { mergeUploadedMediaIntoBody } from "../utils/uploadedMedia.js";
import { emitChatMessageEvent, emitChatThreadReadEvent, emitChatThreadUpdatedEvent } from "../socket/chatSocket.js";
import { ChatMessage } from "../models/chatMessage.model.js";
import { ChatThread } from "../models/chatThread.model.js";
import { User } from "../models/user.model.js";

const CHAT_ATTACHMENT_FIELDS = ["attachments", "attachment", "files", "file"];

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const parseMaybeJson = (value) => {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return value;

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
};

const escapeRegex = (input) => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseObjectId = (value, fieldName) => {
  const id = asString(value);
  if (!id) return null;

  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(`${fieldName} must be a valid id.`, httpStatus.BAD_REQUEST);
  }

  return id;
};

const parsePage = (value) => {
  const page = Number(value || 1);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
};

const parseLimit = (value, defaultValue = 20, maxValue = 100) => {
  const limit = Number(value || defaultValue);
  if (!Number.isFinite(limit) || limit <= 0) return defaultValue;
  return Math.min(Math.floor(limit), maxValue);
};

const buildPagination = (page, limit, total) => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});

const toProfileImageUrl = (profileImage) => {
  if (!profileImage) return null;
  if (typeof profileImage === "string") {
    const value = asString(profileImage);
    return value || null;
  }

  if (typeof profileImage === "object") {
    const value = asString(profileImage.url || profileImage.path || profileImage.secure_url);
    return value || null;
  }

  return null;
};

const normalizeMediaAsset = (rawValue) => {
  const value = parseMaybeJson(rawValue);
  if (!value) return null;

  if (typeof value === "string") {
    const url = asString(value);
    if (!url) return null;
    return {
      url,
      publicId: "",
      mimetype: "",
      size: 0,
    };
  }

  if (typeof value !== "object") return null;

  const url = asString(value.url || value.path || value.secure_url);
  if (!url) return null;

  const parsedSize = Number(value.size);
  return {
    url,
    publicId: asString(value.publicId || value.public_id || value.filename),
    mimetype: asString(value.mimetype || value.resource_type || value.format),
    size: Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : 0,
  };
};

const normalizeAttachmentList = (rawValue) => {
  const value = parseMaybeJson(rawValue);
  if (value === undefined || value === null || value === "") return [];

  if (Array.isArray(value)) {
    return value.map(normalizeMediaAsset).filter(Boolean);
  }

  const single = normalizeMediaAsset(value);
  return single ? [single] : [];
};

const getChatBodyFromRequest = (req) =>
  mergeUploadedMediaIntoBody(req.body, req.files, [
    { target: "attachments", fieldNames: CHAT_ATTACHMENT_FIELDS },
  ]);

const requirePremiumAccessForUser = (user) => {
  if (user.role === "admin") return;
  if (!isPremiumActiveUser(user)) {
    throw new AppError("Active premium subscription is required to use chat.", httpStatus.FORBIDDEN);
  }
};

const ensureActivePremiumUser = async (userId) => {
  const parsedId = parseObjectId(userId, "premiumUserId");
  if (!parsedId) {
    throw new AppError("premiumUserId is required.", httpStatus.BAD_REQUEST);
  }

  const user = await User.findById(parsedId).select("firstName email role isActive selectedPlan subscriptionStatus");
  if (!user || !user.isActive) {
    throw new AppError("Premium user not found.", httpStatus.NOT_FOUND);
  }

  if (user.role !== "user") {
    throw new AppError("premiumUserId must be a user account.", httpStatus.BAD_REQUEST);
  }

  if (!isPremiumActiveUser(user)) {
    throw new AppError("Selected user must have an active premium subscription.", httpStatus.BAD_REQUEST);
  }

  return user;
};

const getSingleActiveAdmin = async () => {
  const admins = await User.find({ role: "admin", isActive: true })
    .sort({ createdAt: 1 })
    .limit(2)
    .select("firstName email role");

  if (admins.length === 0) {
    throw new AppError("No active admin is available for chat.", httpStatus.NOT_FOUND);
  }

  if (admins.length > 1) {
    throw new AppError(
      "Chat is configured for a single coach, but multiple active admin accounts were found.",
      httpStatus.BAD_REQUEST
    );
  }

  return admins[0];
};

const toUserLite = (user) => ({
  id: user._id,
  firstName: user.firstName,
  email: user.email,
  role: user.role,
  profileImage: toProfileImageUrl(user.profileImage),
});

const toMessage = (message, currentUserId) => ({
  id: message._id,
  threadId: message.thread,
  sender: message.sender && typeof message.sender === "object" ? toUserLite(message.sender) : { id: message.sender },
  recipient:
    message.recipient && typeof message.recipient === "object"
      ? toUserLite(message.recipient)
      : { id: message.recipient },
  message: message.message,
  attachments: normalizeAttachmentList(message.attachments),
  readAt: message.readAt || null,
  isMine: message.sender && message.sender._id
    ? message.sender._id.toString() === currentUserId.toString()
    : message.sender?.toString() === currentUserId.toString(),
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
});

const toThread = (thread, currentUser) => {
  const isAdmin = currentUser.role === "admin";
  const counterpart = isAdmin ? thread.premiumUser : thread.admin;

  return {
    id: thread._id,
    admin: thread.admin && typeof thread.admin === "object" ? toUserLite(thread.admin) : { id: thread.admin },
    premiumUser:
      thread.premiumUser && typeof thread.premiumUser === "object" ? toUserLite(thread.premiumUser) : { id: thread.premiumUser },
    counterpart: counterpart && typeof counterpart === "object" ? toUserLite(counterpart) : { id: counterpart },
    lastMessagePreview: thread.lastMessagePreview || "",
    lastMessageAt: thread.lastMessageAt || thread.updatedAt,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
};

const canAccessThread = (thread, user) => {
  if (user.role === "admin") {
    return thread.admin.toString() === user._id.toString();
  }

  if (!isPremiumActiveUser(user)) {
    return false;
  }

  return thread.premiumUser.toString() === user._id.toString();
};

const getAccessibleThread = async (threadId, user) => {
  const parsedThreadId = parseObjectId(threadId, "threadId");
  if (!parsedThreadId) {
    throw new AppError("threadId is required.", httpStatus.BAD_REQUEST);
  }

  const thread = await ChatThread.findById(parsedThreadId);
  if (!thread || !thread.isActive) {
    throw new AppError("Chat thread not found.", httpStatus.NOT_FOUND);
  }

  if (!canAccessThread(thread, user)) {
    throw new AppError("You are not allowed to access this chat thread.", httpStatus.FORBIDDEN);
  }

  return thread;
};

const getOrCreateThread = async ({ adminId, premiumUserId, createdBy }) => {
  let thread = await ChatThread.findOne({ admin: adminId, premiumUser: premiumUserId });

  if (!thread) {
    thread = await ChatThread.create({
      admin: adminId,
      premiumUser: premiumUserId,
      createdBy,
      lastMessageAt: new Date(),
    });
  }

  return thread;
};

export const listChatThreads = catchAsync(async (req, res) => {
  requirePremiumAccessForUser(req.user);

  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;
  const search = asString(req.query.search);

  const filter = req.user.role === "admin" ? { admin: req.user._id, isActive: true } : { premiumUser: req.user._id, isActive: true };

  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    const roleFilter = req.user.role === "admin" ? { role: "user" } : { role: "admin" };
    const counterpartIds = await User.find({
      ...roleFilter,
      isActive: true,
      $or: [{ firstName: pattern }, { email: pattern }],
    }).distinct("_id");

    if (counterpartIds.length === 0) {
      return res.status(httpStatus.OK).json({
        success: true,
        data: [],
        meta: buildPagination(page, limit, 0),
      });
    }

    if (req.user.role === "admin") {
      filter.premiumUser = { $in: counterpartIds };
    } else {
      filter.admin = { $in: counterpartIds };
    }
  }

  const [threads, total] = await Promise.all([
    ChatThread.find(filter)
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("admin", "firstName email role profileImage")
      .populate("premiumUser", "firstName email role profileImage"),
    ChatThread.countDocuments(filter),
  ]);

  const threadIds = threads.map((thread) => thread._id);
  const unreadAgg = threadIds.length
    ? await ChatMessage.aggregate([
        {
          $match: {
            thread: { $in: threadIds },
            recipient: req.user._id,
            readAt: null,
          },
        },
        { $group: { _id: "$thread", unreadCount: { $sum: 1 } } },
      ])
    : [];

  const unreadMap = new Map(unreadAgg.map((item) => [item._id.toString(), item.unreadCount]));

  res.status(httpStatus.OK).json({
    success: true,
    data: threads.map((thread) => ({
      ...toThread(thread, req.user),
      unreadCount: unreadMap.get(thread._id.toString()) || 0,
    })),
    meta: buildPagination(page, limit, total),
  });
});

export const createOrGetChatThread = catchAsync(async (req, res) => {
  requirePremiumAccessForUser(req.user);

  let adminId = null;
  let premiumUserId = null;

  if (req.user.role === "admin") {
    const premiumUser = await ensureActivePremiumUser(req.body.premiumUserId || req.body.userId);
    adminId = req.user._id;
    premiumUserId = premiumUser._id;
  } else {
    if (!isPremiumActiveUser(req.user)) {
      throw new AppError("Active premium subscription is required to use chat.", httpStatus.FORBIDDEN);
    }

    const admin = await getSingleActiveAdmin();
    adminId = admin._id;
    premiumUserId = req.user._id;
  }

  const thread = await getOrCreateThread({
    adminId,
    premiumUserId,
    createdBy: req.user._id,
  });

  const populated = await ChatThread.findById(thread._id)
    .populate("admin", "firstName email role profileImage")
    .populate("premiumUser", "firstName email role profileImage");

  res.status(httpStatus.OK).json({
    success: true,
    data: toThread(populated, req.user),
  });
});

export const getChatMessages = catchAsync(async (req, res) => {
  requirePremiumAccessForUser(req.user);

  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, 30, 200);
  const skip = (page - 1) * limit;
  const thread = await getAccessibleThread(req.params.threadId, req.user);

  const [messages, total] = await Promise.all([
    ChatMessage.find({ thread: thread._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("sender", "firstName email role profileImage")
      .populate("recipient", "firstName email role profileImage"),
    ChatMessage.countDocuments({ thread: thread._id }),
  ]);

  const ordered = [...messages].reverse();

  res.status(httpStatus.OK).json({
    success: true,
    data: ordered.map((message) => toMessage(message, req.user._id)),
    meta: buildPagination(page, limit, total),
  });
});

export const sendChatMessage = catchAsync(async (req, res) => {
  requirePremiumAccessForUser(req.user);

  const thread = await getAccessibleThread(req.params.threadId, req.user);
  const payload = getChatBodyFromRequest(req);
  const messageText = asString(payload.message || payload.text);
  const attachments = normalizeAttachmentList(payload.attachments);

  if (!messageText && attachments.length === 0) {
    throw new AppError("message or attachment is required.", httpStatus.BAD_REQUEST);
  }

  const senderId = req.user._id;
  const recipientId =
    req.user.role === "admin"
      ? thread.premiumUser
      : thread.admin;

  const message = await ChatMessage.create({
    thread: thread._id,
    sender: senderId,
    recipient: recipientId,
    message: messageText,
    attachments,
  });

  thread.lastMessagePreview = messageText
    ? messageText.slice(0, 500)
    : attachments.length === 1
      ? "Attachment"
      : `${attachments.length} attachments`;
  thread.lastMessageAt = message.createdAt;
  await thread.save({ validateBeforeSave: false });

  const populated = await ChatMessage.findById(message._id)
    .populate("sender", "firstName email role profileImage")
    .populate("recipient", "firstName email role profileImage");

  const responseMessage = toMessage(populated, req.user._id);
  const threadSummary = {
    id: thread._id,
    lastMessagePreview: thread.lastMessagePreview || "",
    lastMessageAt: thread.lastMessageAt || thread.updatedAt,
    updatedAt: thread.updatedAt,
  };

  emitChatMessageEvent({
    threadId: thread._id,
    userIds: [senderId, recipientId],
    message: responseMessage,
  });

  emitChatThreadUpdatedEvent({
    threadId: thread._id,
    userIds: [senderId, recipientId],
    thread: threadSummary,
  });

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Message sent successfully.",
    data: responseMessage,
  });
});

export const markChatThreadAsRead = catchAsync(async (req, res) => {
  requirePremiumAccessForUser(req.user);

  const thread = await getAccessibleThread(req.params.threadId, req.user);
  const now = new Date();

  const result = await ChatMessage.updateMany(
    { thread: thread._id, recipient: req.user._id, readAt: null },
    { $set: { readAt: now } }
  );

  const counterpartId = req.user.role === "admin" ? thread.premiumUser : thread.admin;

  emitChatThreadReadEvent({
    threadId: thread._id,
    userIds: [req.user._id, counterpartId],
    readerId: req.user._id,
    markedCount: result.modifiedCount || 0,
    readAt: now,
  });

  res.status(httpStatus.OK).json({
    success: true,
    message: "Thread marked as read.",
    data: {
      markedCount: result.modifiedCount || 0,
      readAt: now,
    },
  });
});

export const getPremiumUsersForChat = catchAsync(async (req, res) => {
  const search = asString(req.query.search);
  const query = {
    role: "user",
    isActive: true,
    selectedPlan: "premium_plan",
    subscriptionStatus: "active",
  };

  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    query.$or = [{ firstName: pattern }, { email: pattern }];
  }

  const users = await User.find(query)
    .sort({ firstName: 1, email: 1 })
    .limit(100)
    .select("firstName email role selectedPlan subscriptionStatus profileImage");

  res.status(httpStatus.OK).json({
    success: true,
    data: users.map((user) => ({
      ...toUserLite(user),
      selectedPlan: user.selectedPlan,
      subscriptionStatus: user.subscriptionStatus,
    })),
  });
});
