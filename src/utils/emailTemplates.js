const APP_NAME = "DisabilityMNE";
const APP_URL = String(process.env.APP_BASE_URL || "").trim();

const COLORS = {
  background: "#071425",
  surface: "#0d2139",
  surfaceAlt: "#123050",
  accent: "#1fb6ff",
  accentSoft: "#d9f4ff",
  text: "#f6fbff",
  muted: "#a8bfd4",
  border: "#21486b",
  success: "#20c997",
  warning: "#ffd166",
};

const escapeHtml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatCurrency = (amount, currency = "USD") => {
  const normalizedAmount = Number(amount || 0);

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: String(currency || "USD").toUpperCase(),
      minimumFractionDigits: normalizedAmount % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(normalizedAmount);
  } catch {
    return `${String(currency || "USD").toUpperCase()} ${normalizedAmount.toFixed(2)}`;
  }
};

const formatDateTime = (value) => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return "N/A";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

const getGreetingName = (firstName) => {
  const trimmed = String(firstName || "").trim();
  return trimmed || "there";
};

const renderActionButton = (label) => {
  if (!APP_URL) {
    return "";
  }

  return `
    <div style="margin-top: 28px;">
      <a href="${escapeHtml(APP_URL)}" style="display: inline-block; background: linear-gradient(135deg, ${COLORS.accent} 0%, #52d3ff 100%); color: ${COLORS.background}; text-decoration: none; font-weight: 700; padding: 14px 22px; border-radius: 999px;">
        ${escapeHtml(label)}
      </a>
    </div>
  `;
};

const renderInfoRow = (label, value) => `
  <tr>
    <td style="padding: 10px 0; color: ${COLORS.muted}; font-size: 13px; border-bottom: 1px solid ${COLORS.border}; vertical-align: top;">
      ${escapeHtml(label)}
    </td>
    <td style="padding: 10px 0; color: ${COLORS.text}; font-size: 14px; font-weight: 600; text-align: right; border-bottom: 1px solid ${COLORS.border}; vertical-align: top;">
      ${escapeHtml(value)}
    </td>
  </tr>
`;

const buildShell = ({ preheader, eyebrow, title, subtitle, bodyHtml, footerNote = "" }) => `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin: 0; padding: 0; background: ${COLORS.background}; font-family: Arial, Helvetica, sans-serif; color: ${COLORS.text};">
    <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; mso-hide: all;">
      ${escapeHtml(preheader)}
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background: radial-gradient(circle at top, #13365a 0%, ${COLORS.background} 52%); padding: 24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 620px;">
            <tr>
              <td style="padding: 0 0 16px 0; text-align: center;">
                <div style="display: inline-block; padding: 8px 14px; border: 1px solid rgba(31, 182, 255, 0.35); border-radius: 999px; color: ${COLORS.accent}; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase;">
                  ${escapeHtml(APP_NAME)}
                </div>
              </td>
            </tr>
            <tr>
              <td style="background: linear-gradient(180deg, rgba(18, 48, 80, 0.98) 0%, rgba(13, 33, 57, 0.98) 100%); border: 1px solid ${COLORS.border}; border-radius: 28px; padding: 36px 28px; box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);">
                <div style="height: 6px; width: 84px; border-radius: 999px; background: linear-gradient(135deg, ${COLORS.accent} 0%, #52d3ff 100%); margin-bottom: 22px;"></div>
                <div style="color: ${COLORS.accent}; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 14px;">
                  ${escapeHtml(eyebrow)}
                </div>
                <h1 style="margin: 0 0 12px 0; font-size: 30px; line-height: 1.2; color: ${COLORS.text};">
                  ${escapeHtml(title)}
                </h1>
                <p style="margin: 0 0 28px 0; color: ${COLORS.muted}; font-size: 15px; line-height: 1.7;">
                  ${escapeHtml(subtitle)}
                </p>
                ${bodyHtml}
                <div style="margin-top: 28px; padding-top: 22px; border-top: 1px solid ${COLORS.border}; color: ${COLORS.muted}; font-size: 12px; line-height: 1.7;">
                  ${escapeHtml(footerNote || "This is an automated email from DisabilityMNE.")}
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

const getPaymentMethodLabel = ({ paymentMethod, cardBrand, cardLast4 }) => {
  if (paymentMethod === "card" && cardLast4) {
    const brandLabel = cardBrand ? `${cardBrand.toUpperCase()} ` : "";
    return `${brandLabel}ending in ${cardLast4}`;
  }

  if (paymentMethod === "bank_account") {
    return "Bank account";
  }

  if (paymentMethod === "manual") {
    return "Manual activation";
  }

  if (paymentMethod === "apple_iap") {
    return "Apple In-App Purchase";
  }

  return String(paymentMethod || "Unknown");
};

export const buildPasswordResetOtpEmail = ({ firstName, otp, expiresInMinutes = 10 }) => {
  const safeOtp = escapeHtml(otp);
  const subject = `Your ${APP_NAME} password reset code`;
  const greetingName = getGreetingName(firstName);

  const html = buildShell({
    preheader: `Use ${otp} to reset your DisabilityMNE password.`,
    eyebrow: "Account Security",
    title: "Reset code ready",
    subtitle: `Use this one-time password to continue resetting your ${APP_NAME} account password.`,
    footerNote: "If you did not request a password reset, you can safely ignore this email.",
    bodyHtml: `
      <div style="padding: 22px; background: rgba(7, 20, 37, 0.55); border: 1px solid ${COLORS.border}; border-radius: 22px;">
        <p style="margin: 0 0 18px 0; color: ${COLORS.text}; font-size: 15px; line-height: 1.7;">
          Hi ${escapeHtml(greetingName)},
        </p>
        <p style="margin: 0 0 22px 0; color: ${COLORS.muted}; font-size: 14px; line-height: 1.7;">
          Enter the code below in the app to confirm your password reset request.
        </p>
        <div style="padding: 20px 16px; border-radius: 20px; background: linear-gradient(135deg, rgba(31, 182, 255, 0.12) 0%, rgba(82, 211, 255, 0.06) 100%); border: 1px solid rgba(31, 182, 255, 0.38); text-align: center;">
          <div style="color: ${COLORS.accent}; font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; margin-bottom: 10px;">
            One-Time Password
          </div>
          <div style="color: ${COLORS.text}; font-size: 34px; font-weight: 700; letter-spacing: 0.24em;">
            ${safeOtp}
          </div>
        </div>
        <div style="margin-top: 18px; color: ${COLORS.warning}; font-size: 13px; font-weight: 700;">
          Expires in ${escapeHtml(expiresInMinutes)} minutes
        </div>
        <p style="margin: 18px 0 0 0; color: ${COLORS.muted}; font-size: 13px; line-height: 1.7;">
          For your security, never share this code with anyone.
        </p>
        ${renderActionButton("Open DisabilityMNE")}
      </div>
    `,
  });

  const text = [
    `Hi ${greetingName},`,
    "",
    `Use this one-time password to reset your ${APP_NAME} password: ${otp}`,
    `This code expires in ${expiresInMinutes} minutes.`,
    "",
    "If you did not request a password reset, you can ignore this email.",
  ].join("\n");

  return { subject, html, text };
};

export const buildPaymentReceiptEmail = ({
  firstName,
  planName,
  amount,
  currency,
  paymentMethod,
  cardBrand,
  cardLast4,
  transactionId,
  paidAt,
  subscriptionEndsAt,
}) => {
  const greetingName = getGreetingName(firstName);
  const amountLabel = formatCurrency(amount, currency);
  const isFreeActivation = Number(amount || 0) <= 0;
  const title = isFreeActivation ? "Plan activated successfully" : "Payment received";
  const subject = isFreeActivation
    ? `${APP_NAME} plan activation confirmation`
    : `${APP_NAME} payment receipt for ${planName}`;

  const html = buildShell({
    preheader: isFreeActivation
      ? `${planName} has been activated on your DisabilityMNE account.`
      : `Your payment for ${planName} was processed successfully.`,
    eyebrow: isFreeActivation ? "Subscription Active" : "Receipt",
    title,
    subtitle: isFreeActivation
      ? `Your ${planName} plan is now available inside ${APP_NAME}.`
      : `Your ${planName} payment was completed successfully and your subscription is active.`,
    footerNote: "Keep this email for your records. Contact support if any payment detail looks incorrect.",
    bodyHtml: `
      <div style="padding: 22px; background: rgba(7, 20, 37, 0.55); border: 1px solid ${COLORS.border}; border-radius: 22px;">
        <div style="display: inline-block; padding: 8px 14px; border-radius: 999px; background: rgba(32, 201, 151, 0.12); color: ${COLORS.success}; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;">
          Successful
        </div>
        <p style="margin: 18px 0 20px 0; color: ${COLORS.text}; font-size: 15px; line-height: 1.7;">
          Hi ${escapeHtml(greetingName)}, your ${escapeHtml(planName)} ${isFreeActivation ? "activation" : "payment"} has been recorded.
        </p>
        <div style="padding: 20px; border-radius: 22px; background: linear-gradient(135deg, rgba(31, 182, 255, 0.12) 0%, rgba(82, 211, 255, 0.05) 100%); border: 1px solid rgba(31, 182, 255, 0.32); margin-bottom: 22px;">
          <div style="color: ${COLORS.muted}; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 10px;">
            ${isFreeActivation ? "Activated Plan" : "Amount Paid"}
          </div>
          <div style="color: ${COLORS.text}; font-size: 34px; font-weight: 700;">
            ${escapeHtml(isFreeActivation ? planName : amountLabel)}
          </div>
        </div>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse: collapse;">
          ${renderInfoRow("Plan", planName)}
          ${renderInfoRow("Reference", transactionId || "N/A")}
          ${renderInfoRow("Paid on", formatDateTime(paidAt))}
          ${renderInfoRow("Payment method", getPaymentMethodLabel({ paymentMethod, cardBrand, cardLast4 }))}
          ${renderInfoRow("Status", "Succeeded")}
          ${subscriptionEndsAt ? renderInfoRow("Access until", formatDateTime(subscriptionEndsAt)) : ""}
        </table>
        ${renderActionButton("Open DisabilityMNE")}
      </div>
    `,
  });

  const text = [
    `Hi ${greetingName},`,
    "",
    isFreeActivation
      ? `Your ${planName} plan has been activated successfully.`
      : `We received your payment of ${amountLabel} for the ${planName} plan.`,
    `Reference: ${transactionId || "N/A"}`,
    `Paid on: ${formatDateTime(paidAt)}`,
    `Payment method: ${getPaymentMethodLabel({ paymentMethod, cardBrand, cardLast4 })}`,
    subscriptionEndsAt ? `Access until: ${formatDateTime(subscriptionEndsAt)}` : "",
    "",
    "Keep this email for your records.",
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, html, text };
};
