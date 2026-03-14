import { Server } from "socket.io";
import { verifyAccessToken } from "../utils/authToken.js";
import { User } from "../models/user.model.js";

let ioInstance = null;

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const toUserRoom = (userId) => `user:${asString(userId)}`;
const toThreadRoom = (threadId) => `thread:${asString(threadId)}`;

const getCorsConfig = () => {
  const origin = process.env.CORS_ORIGIN || "*";

  return {
    origin: origin === "*" ? "*" : origin.split(",").map((item) => item.trim()),
    credentials: origin === "*" ? false : true,
    methods: ["GET", "POST"],
  };
};

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

const toUniqueIds = (ids = []) => [...new Set(ids.map((id) => asString(id)).filter(Boolean))];

export const initChatSocket = (httpServer) => {
  if (ioInstance) return ioInstance;

  ioInstance = new Server(httpServer, {
    cors: getCorsConfig(),
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

  emitToUserRooms(userIds, "chat:message:new", payload);

  const normalizedThreadId = asString(threadId);
  if (normalizedThreadId) {
    ioInstance.to(toThreadRoom(normalizedThreadId)).emit("chat:message:new", payload);
  }
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
