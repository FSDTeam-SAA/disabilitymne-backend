import express from "express";
import morgan from "morgan";
import cors from "cors";
import helmet from "helmet";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { notFound } from "./middlewares/notFound.js";
import { globalErrorHandler } from "./middlewares/globalErrorHandler.js";
import { buildCorsOptions } from "./config/cors.js";

import uploadRoutes from "./routes/upload.routes.js";
import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import programRoutes from "./routes/program.routes.js";
import exerciseRoutes from "./routes/exercise.routes.js";
import recipeRoutes from "./routes/recipe.routes.js";
import chatRoutes from "./routes/chat.routes.js";
import nutritionRoutes from "./routes/nutrition.routes.js";
import adminRoutes from "./routes/admin.routes.js";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Core middlewares
 */
app.use(helmet());
app.use(
  express.json({
    limit: "10mb",
    verify: (req, res, buf) => {
      if (req.originalUrl.startsWith("/api/v1/payments/webhook")) {
        req.rawBody = Buffer.from(buf);
      }
    },
  })
);
app.use(express.urlencoded({ extended: true }));

const corsOptions = buildCorsOptions();
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

/**
 * Security / sanitization
 */
app.use(mongoSanitize());
app.use(hpp());
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

/**
 * Health check
 */
app.get("/health", (req, res) => {
  res.status(200).json({ success: true, message: "OK" });
});

/**
 * Routes
 */
app.use("/api/v1/uploads", uploadRoutes);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/payments", paymentRoutes);
app.use("/api/v1/programs", programRoutes);
app.use("/api/v1/exercises", exerciseRoutes);
app.use("/api/v1/recipes", recipeRoutes);
app.use("/api/v1/chat", chatRoutes);
app.use("/api/v1/nutrition", nutritionRoutes);
app.use("/api/v1/admin", adminRoutes);

/**
 * 404 + Global Error Handler
 */
app.use(notFound);
app.use(globalErrorHandler);

export default app;
