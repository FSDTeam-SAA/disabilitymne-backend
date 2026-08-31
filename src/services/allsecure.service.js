import crypto from "node:crypto";
import httpStatus from "http-status";
import AppError from "../utils/AppError.js";

const CONTENT_TYPE = "application/json; charset=utf-8";
const DEFAULT_BASE_URL = "https://asxgw.paymentsandbox.cloud";

const requiredConfig = (name) => {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new AppError(`AllSecure is not configured. Set ${name}.`, httpStatus.INTERNAL_SERVER_ERROR);
  }
  return value;
};

const normalizeBaseUrl = (value) => String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");

export const getAllSecureConfig = () => ({
  baseUrl: normalizeBaseUrl(process.env.ALLSECURE_BASE_URL),
  apiKey: requiredConfig("ALLSECURE_API_KEY"),
  sharedSecret: requiredConfig("ALLSECURE_SHARED_SECRET"),
  username: requiredConfig("ALLSECURE_USERNAME"),
  password: requiredConfig("ALLSECURE_PASSWORD"),
});

export const createAllSecureSignature = ({
  method,
  body = "",
  contentType = CONTENT_TYPE,
  date,
  requestUri,
  sharedSecret,
}) => {
  const bodyHash = crypto.createHash("sha512").update(body, "utf8").digest("hex");
  const message = [String(method).toUpperCase(), bodyHash, contentType, date, requestUri].join("\n");
  return crypto.createHmac("sha512", sharedSecret).update(message, "utf8").digest("base64");
};

const safeSignatureEqual = (provided, expected) => {
  const left = Buffer.from(String(provided || ""), "utf8");
  const right = Buffer.from(String(expected || ""), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

export const verifyAllSecureCallback = ({
  method,
  body,
  contentType,
  date,
  requestUri,
  signature,
  now = Date.now(),
}) => {
  const { sharedSecret } = getAllSecureConfig();
  if (!signature || !date) return false;

  const timestamp = Date.parse(date);
  const toleranceSeconds = Math.max(30, Number(process.env.ALLSECURE_CALLBACK_TOLERANCE_SECONDS || 300));
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > toleranceSeconds * 1000) return false;

  const expected = createAllSecureSignature({
    method,
    body,
    contentType,
    date,
    requestUri,
    sharedSecret,
  });
  return safeSignatureEqual(signature, expected);
};

const requestAllSecure = async ({ method, requestUri, payload }) => {
  const config = getAllSecureConfig();
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const date = new Date().toUTCString();
  const signature = createAllSecureSignature({
    method,
    body,
    contentType: CONTENT_TYPE,
    date,
    requestUri,
    sharedSecret: config.sharedSecret,
  });
  const authorization = Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64");

  let response;
  try {
    response = await fetch(`${config.baseUrl}${requestUri}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": CONTENT_TYPE,
        Authorization: `Basic ${authorization}`,
        Date: date,
        "X-Date": date,
        "X-Signature": signature,
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(Number(process.env.ALLSECURE_TIMEOUT_MS || 15000)),
    });
  } catch (error) {
    throw new AppError(`Unable to reach AllSecure: ${error.message}`, httpStatus.BAD_GATEWAY);
  }

  const responseText = await response.text();
  let data;
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new AppError("AllSecure returned an invalid response.", httpStatus.BAD_GATEWAY);
  }

  if (!response.ok || data.success === false) {
    const gatewayMessage = String(data.errorMessage || data.errors?.[0]?.errorMessage || "Request failed.");
    const error = new AppError(`AllSecure: ${gatewayMessage}`, httpStatus.BAD_GATEWAY);
    error.gatewayCode = data.errorCode || data.errors?.[0]?.errorCode || null;
    throw error;
  }

  return data;
};

export const createHostedDebit = async (payload) => {
  const { apiKey } = getAllSecureConfig();
  const requestUri = `/api/v3/transaction/${encodeURIComponent(apiKey)}/debit`;
  return requestAllSecure({ method: "POST", requestUri, payload });
};

export const getTransactionStatus = async (merchantTransactionId) => {
  const { apiKey } = getAllSecureConfig();
  const requestUri = `/api/v3/status/${encodeURIComponent(apiKey)}/getByMerchantTransactionId/${encodeURIComponent(
    merchantTransactionId
  )}`;
  return requestAllSecure({ method: "GET", requestUri });
};

export const ALLSECURE_CONTENT_TYPE = CONTENT_TYPE;
