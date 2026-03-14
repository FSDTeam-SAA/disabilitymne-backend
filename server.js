import dotenv from "dotenv";
dotenv.config();

import http from "http";
import app from "./src/app.js";
import { connectDB } from "./src/config/db.js";
import { initChatSocket } from "./src/socket/chatSocket.js";

const PORT = process.env.PORT || 8000;

(async () => {
  await connectDB();
  const server = http.createServer(app);
  initChatSocket(server);

  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Server running on http://localhost:${PORT} (${process.env.NODE_ENV || "development"})`);
  });
})();
