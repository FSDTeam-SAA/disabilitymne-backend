import httpStatus from "http-status";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";

/**
 * POST /api/v1/uploads/image
 * form-data: file=<image>, folder=<optional>
 */
export const uploadSingleImage = catchAsync(async (req, res) => {
  if (!req.file) throw new AppError("No file found in request. Use form-data key: file", httpStatus.BAD_REQUEST);

  // multer-storage-cloudinary provides these fields on req.file:
  // https://www.npmjs.com/package/multer-storage-cloudinary
  const result = {
    filename: req.file.filename,
    path: req.file.path, // secure_url
    size: req.file.size,
    mimetype: req.file.mimetype,
  };

  res.status(httpStatus.CREATED).json({
    success: true,
    message: "Upload successful",
    data: result,
  });
});
