import httpStatus from "http-status";
import fs from "node:fs/promises";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { uploadMediaFileToR2 } from "../services/r2.service.js";

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const cleanupTemporaryUpload = async (file) => {
  const filePath = asString(file?.path);
  if (!filePath) return;

  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore cleanup errors for temporary upload files.
  }
};

/**
 * POST /api/v1/uploads/image
 * form-data: file=<image>, folder=<optional>
 */
export const uploadSingleImage = catchAsync(async (req, res) => {
  if (!req.file) throw new AppError("No file found in request. Use form-data key: file", httpStatus.BAD_REQUEST);

  try {
    const asset = await uploadMediaFileToR2(req.file, { resourceType: "image", folder: asString(req.body?.folder) });

    res.status(httpStatus.CREATED).json({
      success: true,
      message: "Upload successful",
      data: { url: asset.url },
    });
  } finally {
    await cleanupTemporaryUpload(req.file);
  }
});

/**
 * POST /api/v1/uploads/video
 * form-data: file=<video>, folder=<optional>
 */
export const uploadSingleVideo = catchAsync(async (req, res) => {
  if (!req.file) throw new AppError("No file found in request. Use form-data key: file", httpStatus.BAD_REQUEST);

  try {
    const asset = await uploadMediaFileToR2(req.file, { resourceType: "video", folder: asString(req.body?.folder) });

    res.status(httpStatus.CREATED).json({
      success: true,
      message: "Upload successful",
      data: { url: asset.url },
    });
  } finally {
    await cleanupTemporaryUpload(req.file);
  }
});
