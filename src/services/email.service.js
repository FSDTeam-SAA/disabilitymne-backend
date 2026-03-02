import nodemailer from "nodemailer";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

let transporter;
let hasLoggedMissingConfig = false;

const getTrimmedEnv = (key, fallback = "") => String(process.env[key] || fallback).trim();

const parseBooleanEnv = (value, fallback = false) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  return TRUE_VALUES.has(normalized);
};

const getSmtpConfig = () => {
  const port = Number(getTrimmedEnv("SMTP_PORT", "587"));

  return {
    host: getTrimmedEnv("SMTP_HOST"),
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure: parseBooleanEnv(process.env.SMTP_SECURE, false),
    user: getTrimmedEnv("SMTP_USER"),
    pass: getTrimmedEnv("SMTP_PASS"),
  };
};

const getFromConfig = () => ({
  name: getTrimmedEnv("EMAIL_FROM_NAME", "DisabilityMNE"),
  address: getTrimmedEnv("EMAIL_FROM_ADDRESS"),
});

const formatFromHeader = (fromConfig) => {
  if (!fromConfig.name) {
    return fromConfig.address;
  }

  return `"${fromConfig.name.replace(/"/g, "")}" <${fromConfig.address}>`;
};

export const isEmailConfigured = () => {
  const smtp = getSmtpConfig();
  const from = getFromConfig();
  return Boolean(smtp.host && smtp.port && from.address);
};

const getTransporter = () => {
  if (transporter) {
    return transporter;
  }

  const smtp = getSmtpConfig();
  const auth = smtp.user || smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined;

  transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth,
  });

  return transporter;
};

export const sendEmail = async ({ to, subject, html, text, replyTo }) => {
  const recipient = String(to || "").trim();

  if (!recipient || !subject || !html) {
    return {
      delivered: false,
      skipped: true,
      reason: "invalid_payload",
    };
  }

  if (!isEmailConfigured()) {
    if (!hasLoggedMissingConfig) {
      hasLoggedMissingConfig = true;
      console.warn("[email] Email delivery skipped because SMTP or sender configuration is missing.");
    }

    return {
      delivered: false,
      skipped: true,
      reason: "missing_config",
    };
  }

  const from = getFromConfig();

  try {
    const info = await getTransporter().sendMail({
      from: formatFromHeader(from),
      to: recipient,
      subject,
      html,
      text: text || undefined,
      replyTo: replyTo || from.address,
    });

    return {
      delivered: true,
      skipped: false,
      messageId: info.messageId || "",
    };
  } catch (error) {
    console.error(`[email] Failed to send "${subject}" to ${recipient}: ${error.message}`);
    return {
      delivered: false,
      skipped: false,
      reason: "send_failed",
    };
  }
};
