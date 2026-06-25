import { Server } from "socket.io";
import { verifyAccessToken } from "../utils/authToken.js";
import { ChatMessage } from "../models/chatMessage.model.js";
import { ChatThread } from "../models/chatThread.model.js";
import { User } from "../models/user.model.js";
import { getSocketCorsOptions } from "../config/cors.js";

let ioInstance = null;

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const toUserRoom = (userId) => `user:${asString(userId)}`;
const toThreadRoom = (threadId) => `thread:${asString(threadId)}`;
const toUniqueIds = (ids = []) => [...new Set(ids.map((id) => asString(id)).filter(Boolean))];

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

const normalizeMediaAsset = (rawValue) => {
  const value = parseMaybeJson(rawValue);
  if (!value) return null;

  if (typeof value === "string") {
    const url = asString(value);
    if (!url) return null;
    return { url, publicId: "", mimetype: "", size: 0 };
  }

  if (typeof value !== "object") return null;

  const url = asString(value.url || value.path || value.secure_url);
  if (!url) return null;

  const parsedSize = Number(value.size);
  return {
    url,
    publicId: asString(value.publicId || value.public_id || value.filename),
    mimetype: asString(value.mimetype || value.type || value.resource_type || value.format),
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

const toProfileImageUrl = (profileImage) => {
  if (!profileImage) return null;
  if (typeof profileImage === "string") return asString(profileImage) || null;
  if (typeof profileImage === "object") {
    return asString(profileImage.url || profileImage.path || profileImage.secure_url) || null;
  }
  return null;
};

const toUserLite = (user) => ({
  id: user?._id || user?.id || user,
  firstName: user?.firstName || "",
  email: user?.email || "",
  role: user?.role || "",
  profileImage: toProfileImageUrl(user?.profileImage),
});

const toMessage = (message, currentUserId) => ({
  id: message._id,
  threadId: message.thread,
  sender: message.sender && typeof message.sender === "object" ? toUserLite(message.sender) : { id: message.sender },
  recipient:
    message.recipient && typeof message.recipient === "object"
      ? toUserLite(message.recipient)
      : { id: message.recipient },
  message: message.message || "",
  attachments: normalizeAttachmentList(message.attachments),
  readAt: message.readAt || null,
  isMine: message.sender && message.sender._id
    ? message.sender._id.toString() === currentUserId.toString()
    : message.sender?.toString() === currentUserId.toString(),
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
});

const extractAccessToken = (socket) => {
  const authToken = asString(socket.handshake?.auth?.token);
  if (authToken) return authToken;

  const queryToken = asString(socket.handshake?.query?.token);
  if (queryToken) return queryToken;

  const authHeader = asString(socket.handshake?.headers?.authorization);
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.split(" ").slice(1).join(" ").trim();
  }

  return "";
};

const canAccessThread = (thread, userId, role) => {
  if (!thread?.isActive) return false;
  if (role === "admin") return thread.admin.toString() === userId.toString();
  return thread.premiumUser.toString() === userId.toString();
};

const getAttachmentPreview = (attachments) => {
  if (attachments.length === 0) return "";
  if (attachments.length === 1) {
    const mimetype = asString(attachments[0].mimetype).toLowerCase();
    if (mimetype.startsWith("image/")) return "Photo";
    if (mimetype.startsWith("video/")) return "Video";
    return "Attachment";
  }
  return `${attachments.length} attachments`;
};

const createSocketChatMessage = async ({ payload, senderUser }) => {
  const threadId = asString(payload?.threadId);
  const messageText = asString(payload?.message || payload?.text);
  const attachments = normalizeAttachmentList(payload?.attachments);

  if (!threadId) {
    throw new Error("threadId is required.");
  }

  if (!messageText && attachments.length === 0) {
    throw new Error("message or attachment is required.");
  }

  const thread = await ChatThread.findById(threadId);
  if (!thread || !canAccessThread(thread, senderUser.id, senderUser.role)) {
    throw new Error("You are not allowed to access this chat thread.");
  }

  const senderId = senderUser.id;
  const recipientId = senderUser.role === "admin" ? thread.premiumUser : thread.admin;

  const message = await ChatMessage.create({
    thread: thread._id,
    sender: senderId,
    recipient: recipientId,
    message: messageText,
    attachments,
  });

  thread.lastMessagePreview = messageText ? messageText.slice(0, 500) : getAttachmentPreview(attachments);
  thread.lastMessageAt = message.createdAt;
  await thread.save({ validateBeforeSave: false });

  const populated = await ChatMessage.findById(message._id)
    .populate("sender", "firstName email role profileImage")
    .populate("recipient", "firstName email role profileImage");

  const responseMessage = toMessage(populated, senderId);
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

  return responseMessage;
};

export const initChatSocket = (httpServer) => {
  if (ioInstance) return ioInstance;

  ioInstance = new Server(httpServer, {
    cors: getSocketCorsOptions(),
  });

  ioInstance.use(async (socket, next) => {
    try {
      const token = extractAccessToken(socket);
      if (!token) {
        return next(new Error("Unauthorized: missing access token."));
      }

      let decoded;
      try {
        decoded = verifyAccessToken(token);
      } catch {
        return next(new Error("Unauthorized: invalid or expired token."));
      }

      const user = await User.findById(decoded.id).select("firstName email role isActive accountStatus");
      const accountStatus = user?.accountStatus || "active";
      if (!user || !user.isActive || accountStatus !== "active") {
        return next(new Error("Unauthorized: user not active."));
      }

      socket.data.user = {
        id: user._id.toString(),
        role: user.role,
        firstName: user.firstName || "",
        email: user.email || "",
      };

      return next();
    } catch (error) {
      return next(new Error(`Socket auth failed: ${error.message}`));
    }
  });

  ioInstance.on("connection", (socket) => {
    const userId = asString(socket.data?.user?.id);
    if (userId) {
      socket.join(toUserRoom(userId));
    }

    socket.on("chat:join-thread", (threadId) => {
      const normalizedThreadId = asString(threadId);
      if (normalizedThreadId) {
        socket.join(toThreadRoom(normalizedThreadId));
      }
    });

    socket.on("chat:leave-thread", (threadId) => {
      const normalizedThreadId = asString(threadId);
      if (normalizedThreadId) {
        socket.leave(toThreadRoom(normalizedThreadId));
      }
    });

    socket.on("chat:message:send", async (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};

      try {
        const message = await createSocketChatMessage({
          payload,
          senderUser: socket.data.user,
        });

        reply({ success: true, data: message });
      } catch (error) {
        reply({
          success: false,
          message: asString(error?.message) || "Failed to send message.",
        });
      }
    });
  });

  return ioInstance;
};

export const getChatSocket = () => ioInstance;

const emitToUserRooms = (userIds, eventName, payload) => {
  if (!ioInstance) return;
  for (const userId of toUniqueIds(userIds)) {
    ioInstance.to(toUserRoom(userId)).emit(eventName, payload);
  }
};

export const emitChatMessageEvent = ({ threadId, userIds, message }) => {
  if (!ioInstance) return;

  const payload = {
    threadId: asString(threadId),
    message,
  };

  let target = ioInstance;
  for (const userId of toUniqueIds(userIds)) {
    target = target.to(toUserRoom(userId));
  }
  target.to(toThreadRoom(threadId)).emit("chat:message:new", payload);
};

export const emitChatThreadUpdatedEvent = ({ threadId, userIds, thread }) => {
  if (!ioInstance) return;

  const payload = {
    threadId: asString(threadId),
    thread,
  };

  emitToUserRooms(userIds, "chat:thread:updated", payload);
};

export const emitChatThreadReadEvent = ({ threadId, userIds, readerId, markedCount, readAt }) => {
  if (!ioInstance) return;

  const payload = {
    threadId: asString(threadId),
    readerId: asString(readerId),
    markedCount: Number(markedCount || 0),
    readAt,
  };

  emitToUserRooms(userIds, "chat:thread:read", payload);
};
