import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { initCloudinary } from "../config/cloudinary.js";

const cloudinary = initCloudinary();

// Allow only images by default. You can expand this (pdf, video, etc.)
const imageFileFilter = (req, file, cb) => {
  const ok = file.mimetype?.startsWith("image/");
  if (!ok) return cb(new Error("Only image uploads are allowed."), false);
  cb(null, true);
};

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const folder = (req.body?.folder || "uploads").toString();
    return {
      folder,
      resource_type: "image",
      // keeps original filename but Cloudinary may still ensure uniqueness
      public_id: `${Date.now()}-${file.originalname}`.replace(/\s+/g, "-"),
    };
  },
});

export const uploadImage = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});
