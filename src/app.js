import express from "express";
import morgan from "morgan";
import cors from "cors";
import helmet from "helmet";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";

import { notFound } from "./middlewares/notFound.js";
import { globalErrorHandler } from "./middlewares/globalErrorHandler.js";

import uploadRoutes from "./routes/upload.routes.js";
import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import programRoutes from "./routes/program.routes.js";
import recipeRoutes from "./routes/recipe.routes.js";
import adminRoutes from "./routes/admin.routes.js";

const app = express();

/**
 * Core middlewares
 */
app.use(helmet());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

/**
 * CORS (credentials-safe)
 * NOTE: If you need cookies / auth, set credentials:true and origin to a specific value, not "*".
 */
const origin = process.env.CORS_ORIGIN || "*";
app.use(
  cors({
    origin: origin === "*" ? "*" : origin.split(",").map((s) => s.trim()),
    credentials: origin === "*" ? false : true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  })
);

if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

/**
 * Security / sanitization
 */
app.use(mongoSanitize());
app.use(hpp());

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
app.use("/api/v1/recipes", recipeRoutes);
app.use("/api/v1/admin", adminRoutes);

/**
 * 404 + Global Error Handler
 */
app.use(notFound);
app.use(globalErrorHandler);

export default app;
