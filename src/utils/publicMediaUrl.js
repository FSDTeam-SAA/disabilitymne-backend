const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const normalizePathSlashes = (value) => asString(value).replace(/\\/g, "/");
const DUPLICATE_EXT_REGEX =
  /(\.(?:jpe?g|png|gif|webp|bmp|svg|mp4|mov|avi|mkv|webm|m4v|m4a|mp3|wav|ogg|pdf|heic|heif))\1$/i;

const splitPathQueryHash = (value) => {
  const match = String(value || "").match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  return {
    path: match?.[1] || "",
    query: match?.[2] || "",
    hash: match?.[3] || "",
  };
};

const removeDuplicateTrailingExtension = (value) => {
  const { path, query, hash } = splitPathQueryHash(value);
  if (!path) return value;

  const cleanedPath = path.replace(DUPLICATE_EXT_REGEX, "$1");
  return `${cleanedPath}${query}${hash}`;
};

const getBackendPublicBaseUrl = () => {
  const fromEnv = asString(process.env.BACKEND_PUBLIC_URL);
  if (fromEnv) {
    return fromEnv.replace(/\/+$/, "");
  }

  const port = asString(process.env.PORT) || "8000";
  return `http://localhost:${port}`;
};

const toUploadsRelativePath = (rawValue) => {
  const normalized = normalizePathSlashes(rawValue);
  if (!normalized) return "";

  if (normalized.startsWith("/uploads/")) {
    return normalized;
  }

  if (normalized.startsWith("uploads/")) {
    return `/${normalized}`;
  }

  const marker = "/uploads/";
  const index = normalized.toLowerCase().lastIndexOf(marker);
  if (index >= 0) {
    return normalized.slice(index);
  }

  return "";
};

const isAbsoluteWebUrl = (value) => /^https?:\/\//i.test(value);
const isProtocolRelativeUrl = (value) => /^\/\//.test(value);
const isWindowsAbsolutePath = (value) => /^[A-Za-z]:[\\/]/.test(value);

export const toPublicMediaUrl = (rawValue) => {
  const value = removeDuplicateTrailingExtension(asString(rawValue));
  if (!value) return "";

  if (isAbsoluteWebUrl(value)) {
    return value;
  }

  if (isProtocolRelativeUrl(value)) {
    return `https:${value}`;
  }

  const uploadsRelativePath = toUploadsRelativePath(value);
  if (uploadsRelativePath) {
    return `${getBackendPublicBaseUrl()}${uploadsRelativePath}`;
  }

  if (value.startsWith("/")) {
    return `${getBackendPublicBaseUrl()}${value}`;
  }

  if (isWindowsAbsolutePath(value)) {
    return `${getBackendPublicBaseUrl()}/${normalizePathSlashes(value).replace(/^\/+/, "")}`;
  }

  return value;
};
