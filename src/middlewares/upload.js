import fs from "node:fs";
import path from "node:path";
import multer from "multer";

const IMAGE_MAX_FILE_SIZE = 10 * 1024 * 1024;
const MEDIA_MAX_FILE_SIZE = 100 * 1024 * 1024;
const uploadsRoot = path.join(process.cwd(), "uploads");

const getUploadKind = (file) => {
  const mimetype = String(file?.mimetype || "").toLowerCase();
  if (mimetype.startsWith("video/")) return "video";
  if (mimetype.startsWith("image/")) return "image";
  return "";
};

const formatAllowedKinds = (allowedKinds) => {
  if (allowedKinds.length === 1) {
    return allowedKinds[0];
  }

  return `${allowedKinds.slice(0, -1).join(", ")} and ${allowedKinds[allowedKinds.length - 1]}`;
};

const buildFileFilter = (allowedKinds) => (req, file, cb) => {
  const uploadKind = getUploadKind(file);
  if (!allowedKinds.includes(uploadKind)) {
    return cb(new Error(`Only ${formatAllowedKinds(allowedKinds)} uploads are allowed.`), false);
  }

  cb(null, true);
};

const sanitizePathSegment = (segment) =>
  String(segment || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "");

const sanitizeFolder = (folder) => {
  const normalized = String(folder || "general")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => sanitizePathSegment(part))
    .filter(Boolean)
    .join("/");

  return normalized || "general";
};

const sanitizeFileName = (name) =>
  String(name || "file")
    .trim()
    .replace(/(\.[^/.]+)+$/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "file";

const ensureDirectory = (dirPath, cb) => {
  fs.mkdir(dirPath, { recursive: true }, (error) => {
    if (error) return cb(error);
    cb(null, dirPath);
  });
};

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = sanitizeFolder(req.body?.folder || "general");
    const destinationPath = path.join(uploadsRoot, folder);
    ensureDirectory(destinationPath, cb);
  },
  filename: (req, file, cb) => {
    const originalExt = path.extname(file.originalname || "").toLowerCase();
    const safeName = sanitizeFileName(file.originalname);
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}-${safeName}${originalExt}`);
  },
});

const createUploader = ({ allowedKinds, maxFileSize }) =>
  multer({
    storage: diskStorage,
    fileFilter: buildFileFilter(allowedKinds),
    limits: { fileSize: maxFileSize },
  });

export const uploadImage = createUploader({
  allowedKinds: ["image"],
  maxFileSize: IMAGE_MAX_FILE_SIZE,
});

export const uploadImageFields = (fields) => uploadImage.fields(fields);

export const uploadVideo = createUploader({
  allowedKinds: ["video"],
  maxFileSize: MEDIA_MAX_FILE_SIZE,
});

export const uploadVideoFields = (fields) => uploadVideo.fields(fields);

export const uploadMedia = createUploader({
  allowedKinds: ["image", "video"],
  maxFileSize: MEDIA_MAX_FILE_SIZE,
});

export const uploadMediaFields = (fields) => uploadMedia.fields(fields);
