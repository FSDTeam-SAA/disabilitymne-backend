import httpStatus from "http-status";

/**
 * Global error handler (keeps production responses safe)
 */
export const globalErrorHandler = (err, req, res, next) => {
  void next;

  const statusCode = err.statusCode || httpStatus.INTERNAL_SERVER_ERROR;
  const status = err.status || (String(statusCode).startsWith("4") ? "fail" : "error");

  const payload = {
    success: false,
    status,
    message: err.message || "Something went wrong",
  };

  // Provide more info in dev
  if ((process.env.NODE_ENV || "development") !== "production") {
    payload.stack = err.stack;
    payload.error = err;
  }

  res.status(statusCode).json(payload);
};
