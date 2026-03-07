import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { initCloudinary } from "../config/cloudinary.js";

const cloudinary = initCloudinary();
const IMAGE_MAX_FILE_SIZE = 10 * 1024 * 1024;
const MEDIA_MAX_FILE_SIZE = 100 * 1024 * 1024;

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

const createStorage = () =>
  new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      const folder = (req.body?.folder || "uploads").toString();
      const resourceType = getUploadKind(file) || "image";

      return {
        folder,
        resource_type: resourceType,
        // keeps original filename but Cloudinary may still ensure uniqueness
        public_id: `${Date.now()}-${file.originalname}`.replace(/\s+/g, "-"),
      };
    },
  });

const createUploader = ({ allowedKinds, maxFileSize }) =>
  multer({
    storage: createStorage(),
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
