import "dotenv/config";

import http from "http";
import app from "./src/app.js";
import { connectDB } from "./src/config/db.js";
import { initChatSocket } from "./src/socket/chatSocket.js";

const PORT = process.env.PORT || 8000;

const hasAppleSharedSecret = Boolean(String(process.env.APPLE_IAP_SHARED_SECRET || "").trim());
const hasAppleServerApi = Boolean(
  String(process.env.APPLE_IAP_ISSUER_ID || "").trim() &&
    String(process.env.APPLE_IAP_KEY_ID || "").trim() &&
    (String(process.env.APPLE_IAP_PRIVATE_KEY || "").trim() ||
      String(process.env.APPLE_IAP_PRIVATE_KEY_PATH || "").trim())
);

if (process.env.NODE_ENV === "production" && !hasAppleSharedSecret && !hasAppleServerApi) {
  // eslint-disable-next-line no-console
  console.warn(
    "[startup] Apple IAP is not configured. Set APPLE_IAP_SHARED_SECRET and/or App Store Server API keys (ISSUER_ID, KEY_ID, PRIVATE_KEY)."
  );
}

(async () => {
  await connectDB();
  const server = http.createServer(app);
  initChatSocket(server);

  server.listen(PORT, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`Server running on http://localhost:${PORT} (${process.env.NODE_ENV || "development"})`);
  });
})();
