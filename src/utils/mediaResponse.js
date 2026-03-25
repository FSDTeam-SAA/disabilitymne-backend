import { toPublicMediaUrl } from "./publicMediaUrl.js";

export const toMediaUrl = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return toPublicMediaUrl(value) || null;
  }

  if (typeof value !== "object") {
    return null;
  }

  return toPublicMediaUrl(value.url || value.path || value.secure_url) || null;
};

export const toMediaUrlList = (values) => {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.map((value) => toMediaUrl(value)).filter(Boolean);
};
