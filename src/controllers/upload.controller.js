import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { toUploadedMediaAsset } from "../utils/uploadedMedia.js";

const buildUploadResult = (file) => {
  const asset = toUploadedMediaAsset(file);
  return {
    url: asset?.url || "",
  };
};

/**
 * POST /api/v1/uploads/image
 * form-data: file=<image>, folder=<optional>
 */
export const uploadSingleImage = catchAsync(async (req, res) => {
  if (!req.file) throw new AppError("No file found in request. Use form-data key: file", httpStatus.BAD_REQUEST);

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Upload successful",
    data: buildUploadResult(req.file),
  });
});

/**
 * POST /api/v1/uploads/video
 * form-data: file=<video>, folder=<optional>
 */
export const uploadSingleVideo = catchAsync(async (req, res) => {
  if (!req.file) throw new AppError("No file found in request. Use form-data key: file", httpStatus.BAD_REQUEST);

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Upload successful",
    data: buildUploadResult(req.file),
  });
});
