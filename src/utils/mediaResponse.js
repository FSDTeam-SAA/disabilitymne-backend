const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

export const toMediaUrl = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return asString(value) || null;
  }

  if (typeof value !== "object") {
    return null;
  }

  return asString(value.url || value.path || value.secure_url) || null;
};

export const toMediaUrlList = (values) => {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.map((value) => toMediaUrl(value)).filter(Boolean);
};
