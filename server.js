import "dotenv/config";

import http from "http";
import app from "./src/app.js";
import { connectDB } from "./src/config/db.js";
import { initChatSocket } from "./src/socket/chatSocket.js";
import { seedDefaultHomeBannerIfEmpty } from "./src/services/homeBannerSeed.service.js";
import { syncExpiredSubscriptions } from "./src/services/subscriptionSync.service.js";

const PORT = process.env.PORT || 8000;
const EXPIRY_SYNC_INTERVAL_MS = Number(process.env.SUBSCRIPTION_EXPIRY_SYNC_MS || 5 * 60 * 1000);

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

const startSubscriptionExpirySync = () => {
  const run = async () => {
    try {
      const result = await syncExpiredSubscriptions({ limit: 500 });
      if (result.updated > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[subscription-sync] Expired ${result.updated}/${result.scanned} subscription(s).`
        );
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[subscription-sync] Failed: ${error.message}`);
    }
  };

  run();
  setInterval(run, EXPIRY_SYNC_INTERVAL_MS);
};

(async () => {
  await connectDB();

  try {
    const seedResult = await seedDefaultHomeBannerIfEmpty();
    if (seedResult.seeded) {
      // eslint-disable-next-line no-console
      console.log(`[home-banners] Seeded default homepage photo: ${seedResult.imageUrl}`);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[home-banners] Failed to seed default photo: ${error.message}`);
  }

  const server = http.createServer(app);
  initChatSocket(server);
  startSubscriptionExpirySync();

  server.listen(PORT, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`Server running on http://localhost:${PORT} (${process.env.NODE_ENV || "development"})`);
  });
})();
