import crypto from "node:crypto";
import fs from "node:fs/promises";

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const CLOUDINARY_CLOUD_NAME = asString(process.env.CLOUDINARY_CLOUD_NAME);
const CLOUDINARY_API_KEY = asString(process.env.CLOUDINARY_API_KEY);
const CLOUDINARY_API_SECRET = asString(process.env.CLOUDINARY_API_SECRET);
const CLOUDINARY_UPLOAD_PRESET = asString(process.env.CLOUDINARY_UPLOAD_PRESET);

const ensureCloudinaryConfig = () => {
  if (!CLOUDINARY_CLOUD_NAME) {
    throw new Error("Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME.");
  }

  if (!CLOUDINARY_UPLOAD_PRESET && (!CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET)) {
    throw new Error(
      "Cloudinary is not configured. Set CLOUDINARY_UPLOAD_PRESET, or both CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET."
    );
  }
};

const ensureCloudinaryDeleteConfig = () => {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error("Cloudinary delete requires CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.");
  }
};

const buildCloudinarySignature = (params, apiSecret) => {
  const canonical = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && asString(value) !== "")
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return crypto
    .createHash("sha1")
    .update(`${canonical}${apiSecret}`)
    .digest("hex");
};

const parseCloudinaryError = (payload) =>
  asString(payload?.error?.message || payload?.message || payload?.error_description);

const normalizeResourceType = (resourceType) => {
  const normalized = asString(resourceType).toLowerCase();
  if (normalized === "video") return "video";
  return "image";
};

const inferResourceTypeFromMimetype = (mimetype) => {
  const normalized = asString(mimetype).toLowerCase();
  if (normalized.startsWith("video/")) {
    return "video";
  }
  return "image";
};

export const uploadMediaFileToCloudinary = async (file, options = {}) => {
  ensureCloudinaryConfig();

  const filePath = asString(file?.path);
  if (!filePath) {
    throw new Error("Uploaded file path is missing.");
  }

  const folder = asString(options.folder || "users/profile-images");
  const mimetype = asString(file?.mimetype) || "application/octet-stream";
  const resourceType = normalizeResourceType(options.resourceType || inferResourceTypeFromMimetype(mimetype));
  const base64 = (await fs.readFile(filePath)).toString("base64");
  const dataUri = `data:${mimetype};base64,${base64}`;

  const form = new URLSearchParams();
  form.append("file", dataUri);
  if (folder) {
    form.append("folder", folder);
  }

  if (CLOUDINARY_UPLOAD_PRESET) {
    form.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  } else {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = buildCloudinarySignature({ folder, timestamp }, CLOUDINARY_API_SECRET);

    form.append("timestamp", String(timestamp));
    form.append("api_key", CLOUDINARY_API_KEY);
    form.append("signature", signature);
  }

  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUDINARY_CLOUD_NAME)}/${resourceType}/upload`;
  const response = await fetch(endpoint, {
    method: "POST",
    body: form,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(parseCloudinaryError(payload) || `Cloudinary upload failed with status ${response.status}.`);
  }

  const url = asString(payload?.secure_url || payload?.url);
  if (!url) {
    throw new Error("Cloudinary upload did not return a URL.");
  }

  const size = Number(payload?.bytes ?? file?.size);

  return {
    url,
    publicId: asString(payload?.public_id),
    mimetype,
    size: Number.isFinite(size) && size > 0 ? size : 0,
  };
};

export const uploadMediaUrlToCloudinary = async (sourceUrl, options = {}) => {
  ensureCloudinaryConfig();

  const remoteUrl = asString(sourceUrl);
  if (!remoteUrl) {
    throw new Error("Source media URL is missing.");
  }

  const folder = asString(options.folder || "users/profile-images");
  const resourceType = normalizeResourceType(options.resourceType || "image");

  const form = new URLSearchParams();
  form.append("file", remoteUrl);
  if (folder) {
    form.append("folder", folder);
  }

  if (CLOUDINARY_UPLOAD_PRESET) {
    form.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  } else {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = buildCloudinarySignature({ folder, timestamp }, CLOUDINARY_API_SECRET);

    form.append("timestamp", String(timestamp));
    form.append("api_key", CLOUDINARY_API_KEY);
    form.append("signature", signature);
  }

  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUDINARY_CLOUD_NAME)}/${resourceType}/upload`;
  const response = await fetch(endpoint, {
    method: "POST",
    body: form,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(parseCloudinaryError(payload) || `Cloudinary upload failed with status ${response.status}.`);
  }

  const url = asString(payload?.secure_url || payload?.url);
  if (!url) {
    throw new Error("Cloudinary upload did not return a URL.");
  }

  const size = Number(payload?.bytes);

  return {
    url,
    publicId: asString(payload?.public_id),
    mimetype: asString(payload?.resource_type || resourceType),
    size: Number.isFinite(size) && size > 0 ? size : 0,
  };
};

export const uploadImageFileToCloudinary = async (file, options = {}) =>
  uploadMediaFileToCloudinary(file, {
    ...options,
    resourceType: "image",
  });

export const deleteCloudinaryMediaByPublicId = async (publicId, options = {}) => {
  const normalizedPublicId = asString(publicId);
  if (!normalizedPublicId) {
    return { result: "skipped" };
  }

  ensureCloudinaryDeleteConfig();
  const resourceType = normalizeResourceType(options.resourceType || "image");

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = buildCloudinarySignature({ public_id: normalizedPublicId, timestamp }, CLOUDINARY_API_SECRET);

  const form = new URLSearchParams();
  form.append("public_id", normalizedPublicId);
  form.append("timestamp", String(timestamp));
  form.append("api_key", CLOUDINARY_API_KEY);
  form.append("signature", signature);

  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUDINARY_CLOUD_NAME)}/${resourceType}/destroy`;
  const response = await fetch(endpoint, {
    method: "POST",
    body: form,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(parseCloudinaryError(payload) || `Cloudinary destroy failed with status ${response.status}.`);
  }

  return {
    result: asString(payload?.result || "ok"),
  };
};

export const deleteCloudinaryImageByPublicId = async (publicId) =>
  deleteCloudinaryMediaByPublicId(publicId, { resourceType: "image" });
