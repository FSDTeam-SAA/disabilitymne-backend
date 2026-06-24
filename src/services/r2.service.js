import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const R2_ACCOUNT_ID = asString(process.env.R2_ACCOUNT_ID);
const R2_ACCESS_KEY_ID = asString(process.env.R2_ACCESS_KEY_ID);
const R2_SECRET_ACCESS_KEY = asString(process.env.R2_SECRET_ACCESS_KEY);
const R2_BUCKET_NAME = asString(process.env.R2_BUCKET_NAME);
const R2_PUBLIC_BASE_URL = asString(process.env.R2_PUBLIC_BASE_URL).replace(/\/+$/, "");

let cachedClient = null;

const ensureR2Config = () => {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_BASE_URL) {
    throw new Error(
      "Cloudflare R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, and R2_PUBLIC_BASE_URL."
    );
  }
};

const getR2Client = () => {
  if (cachedClient) return cachedClient;

  cachedClient = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  return cachedClient;
};

const inferResourceTypeFromMimetype = (mimetype) =>
  asString(mimetype).toLowerCase().startsWith("video/") ? "video" : "image";

const normalizeResourceType = (resourceType, mimetype) => {
  const normalized = asString(resourceType).toLowerCase();
  if (normalized === "video" || normalized === "image") return normalized;
  return inferResourceTypeFromMimetype(mimetype);
};

const sanitizeFileName = (name) => {
  const base = path.basename(asString(name) || "file");
  return base.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "file";
};

const buildObjectKey = ({ resourceType, folder, fileName }) => {
  const topFolder = resourceType === "video" ? "videos" : "images";
  const safeFolder = asString(folder).replace(/^\/+|\/+$/g, "");
  const safeName = sanitizeFileName(fileName);
  const uniquePrefix = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;

  return [topFolder, safeFolder, `${uniquePrefix}-${safeName}`].filter(Boolean).join("/");
};

const buildPublicUrl = (key) => `${R2_PUBLIC_BASE_URL}/${key}`;

const putObjectToR2 = async ({ buffer, key, contentType }) => {
  ensureR2Config();

  await getR2Client().send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType || "application/octet-stream",
    })
  );

  return buildPublicUrl(key);
};

export const uploadMediaFileToR2 = async (file, options = {}) => {
  const filePath = asString(file?.path);
  if (!filePath) {
    throw new Error("Uploaded file path is missing.");
  }

  const mimetype = asString(file?.mimetype) || "application/octet-stream";
  const resourceType = normalizeResourceType(options.resourceType, mimetype);
  const buffer = await fs.readFile(filePath);
  const key = buildObjectKey({ resourceType, folder: options.folder, fileName: file?.originalname });
  const url = await putObjectToR2({ buffer, key, contentType: mimetype });
  const size = Number(file?.size);

  return {
    url,
    publicId: key,
    mimetype,
    size: Number.isFinite(size) && size > 0 ? size : buffer.length,
  };
};

export const uploadImageFileToR2 = async (file, options = {}) =>
  uploadMediaFileToR2(file, { ...options, resourceType: "image" });

export const uploadMediaUrlToR2 = async (sourceUrl, options = {}) => {
  const remoteUrl = asString(sourceUrl);
  if (!remoteUrl) {
    throw new Error("Source media URL is missing.");
  }

  const response = await fetch(remoteUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch source media URL (status ${response.status}).`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const mimetype = asString(response.headers.get("content-type")) || "application/octet-stream";
  const resourceType = normalizeResourceType(options.resourceType, mimetype);
  const fileName = remoteUrl.split("/").pop() || "file";
  const key = buildObjectKey({ resourceType, folder: options.folder, fileName });
  const url = await putObjectToR2({ buffer, key, contentType: mimetype });

  return {
    url,
    publicId: key,
    mimetype,
    size: buffer.length,
  };
};

export const isR2Url = (url) => Boolean(R2_PUBLIC_BASE_URL) && asString(url).startsWith(R2_PUBLIC_BASE_URL);

export const deleteR2ObjectByKey = async (key) => {
  const normalizedKey = asString(key);
  if (!normalizedKey) {
    return { result: "skipped" };
  }

  ensureR2Config();

  await getR2Client().send(
    new DeleteObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: normalizedKey,
    })
  );

  return { result: "deleted" };
};
