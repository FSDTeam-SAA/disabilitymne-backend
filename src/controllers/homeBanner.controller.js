import httpStatus from "http-status";
import fs from "node:fs/promises";
import mongoose from "mongoose";
import AppError from "../utils/AppError.js";
import { catchAsync } from "../utils/catchAsync.js";
import { toMediaUrl } from "../utils/mediaResponse.js";
import { deleteR2ObjectByKey, isR2Url, uploadImageFileToR2 } from "../services/r2.service.js";
import { HomeBanner } from "../models/homeBanner.model.js";

const HOME_BANNER_FOLDER = "home-banners";
const HOME_BANNER_IMAGE_FIELDS = ["images", "image", "files"];
const MAX_HOME_BANNERS = 20;

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const parseBoolean = (value, fieldName) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;

  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase().trim();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  throw new AppError(`${fieldName} must be a boolean.`, httpStatus.BAD_REQUEST);
};

const parseObjectId = (value, fieldName) => {
  const id = asString(value);
  if (!id) {
    throw new AppError(`${fieldName} is required.`, httpStatus.BAD_REQUEST);
  }

  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(`${fieldName} must be a valid id.`, httpStatus.BAD_REQUEST);
  }

  return id;
};

const normalizeUploadedFiles = (files) => {
  if (!files) return {};

  if (Array.isArray(files)) {
    return files.reduce((acc, file) => {
      const fieldName = asString(file?.fieldname);
      if (!fieldName) return acc;

      if (!acc[fieldName]) {
        acc[fieldName] = [];
      }

      acc[fieldName].push(file);
      return acc;
    }, {});
  }

  return files;
};

const getUploadedFilesByFieldNames = (files, fieldNames = []) => {
  const groupedFiles = normalizeUploadedFiles(files);
  const uploadedFiles = [];

  for (const fieldName of fieldNames) {
    const fieldFiles = groupedFiles[fieldName];
    if (Array.isArray(fieldFiles) && fieldFiles.length > 0) {
      uploadedFiles.push(...fieldFiles);
    }
  }

  return uploadedFiles;
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

const cleanupTemporaryUploads = async (files = []) => {
  await Promise.all(files.map((file) => cleanupTemporaryUpload(file)));
};

const uploadImagesToR2 = async (files) => {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  try {
    return await Promise.all(
      files.map((file) =>
        uploadImageFileToR2(file, {
          folder: HOME_BANNER_FOLDER,
        })
      )
    );
  } catch (error) {
    throw new AppError(
      asString(error?.message) || "Failed to upload homepage banner image.",
      httpStatus.INTERNAL_SERVER_ERROR
    );
  } finally {
    await cleanupTemporaryUploads(files);
  }
};

const deleteBannerImageFromStorage = async (image) => {
  const publicId = asString(image?.publicId);
  const url = asString(image?.url);

  if (!publicId || !isR2Url(url)) {
    return;
  }

  try {
    await deleteR2ObjectByKey(publicId);
  } catch {
    // Do not fail the request if remote cleanup fails.
  }
};

const serializeHomeBanner = (banner) => ({
  id: String(banner._id),
  imageUrl: toMediaUrl(banner.image),
  sortOrder: Number.isFinite(Number(banner.sortOrder)) ? Number(banner.sortOrder) : 0,
  isActive: Boolean(banner.isActive),
  createdAt: banner.createdAt,
  updatedAt: banner.updatedAt,
});

const getNextSortOrder = async () => {
  const lastBanner = await HomeBanner.findOne().sort({ sortOrder: -1, createdAt: -1 }).lean();
  if (!lastBanner) return 0;
  return Number(lastBanner.sortOrder || 0) + 1;
};

/**
 * GET /api/v1/home-banners
 * Active homepage banners for the mobile app.
 */
export const getHomeBanners = catchAsync(async (req, res) => {
  const banners = await HomeBanner.find({ isActive: true }).sort({ sortOrder: 1, createdAt: 1 }).lean();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Homepage banners fetched successfully.",
    data: banners.map(serializeHomeBanner).filter((banner) => Boolean(banner.imageUrl)),
  });
});

/**
 * GET /api/v1/home-banners/admin
 * All homepage banners for the admin dashboard.
 */
export const getAdminHomeBanners = catchAsync(async (req, res) => {
  const banners = await HomeBanner.find().sort({ sortOrder: 1, createdAt: 1 }).lean();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Homepage banners fetched successfully.",
    data: banners.map(serializeHomeBanner),
  });
});

/**
 * POST /api/v1/home-banners/admin
 * Upload one or more homepage banner images.
 */
export const createHomeBanners = catchAsync(async (req, res) => {
  const uploadedFiles = getUploadedFilesByFieldNames(req.files, HOME_BANNER_IMAGE_FIELDS);
  if (uploadedFiles.length === 0) {
    throw new AppError(
      "At least one image is required. Use form-data key: images",
      httpStatus.BAD_REQUEST
    );
  }

  const existingCount = await HomeBanner.countDocuments();
  if (existingCount + uploadedFiles.length > MAX_HOME_BANNERS) {
    await cleanupTemporaryUploads(uploadedFiles);
    throw new AppError(
      `You can upload a maximum of ${MAX_HOME_BANNERS} homepage photos.`,
      httpStatus.BAD_REQUEST
    );
  }

  const uploadedAssets = await uploadImagesToR2(uploadedFiles);
  if (uploadedAssets.length === 0) {
    throw new AppError("Failed to upload homepage banner images.", httpStatus.BAD_REQUEST);
  }

  const startingSortOrder = await getNextSortOrder();
  const created = await HomeBanner.insertMany(
    uploadedAssets.map((asset, index) => ({
      image: {
        url: asset.url,
        publicId: asset.publicId,
        mimetype: asset.mimetype,
        size: asset.size,
      },
      sortOrder: startingSortOrder + index,
      isActive: true,
    }))
  );

  res.status(httpStatus.CREATED).json({
    success: true,
    message: created.length === 1 ? "Homepage photo uploaded." : "Homepage photos uploaded.",
    data: created.map(serializeHomeBanner),
  });
});

/**
 * PATCH /api/v1/home-banners/admin/reorder
 * Reorder homepage banners.
 */
export const reorderHomeBanners = catchAsync(async (req, res) => {
  const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : [];
  if (orderedIds.length === 0) {
    throw new AppError("orderedIds must be a non-empty array.", httpStatus.BAD_REQUEST);
  }

  const uniqueIds = [];
  const seen = new Set();
  for (const rawId of orderedIds) {
    const id = parseObjectId(rawId, "Banner id");
    if (seen.has(id)) continue;
    seen.add(id);
    uniqueIds.push(id);
  }

  const existingBanners = await HomeBanner.find({ _id: { $in: uniqueIds } }).select("_id");
  if (existingBanners.length !== uniqueIds.length) {
    throw new AppError("One or more banner ids were not found.", httpStatus.NOT_FOUND);
  }

  await Promise.all(
    uniqueIds.map((id, index) => HomeBanner.updateOne({ _id: id }, { $set: { sortOrder: index } }))
  );

  const banners = await HomeBanner.find().sort({ sortOrder: 1, createdAt: 1 }).lean();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Homepage banners reordered.",
    data: banners.map(serializeHomeBanner),
  });
});

/**
 * PATCH /api/v1/home-banners/admin/:bannerId
 * Update visibility or sort order for a single banner.
 */
export const updateHomeBanner = catchAsync(async (req, res) => {
  const bannerId = parseObjectId(req.params.bannerId, "Banner id");
  const banner = await HomeBanner.findById(bannerId);
  if (!banner) {
    throw new AppError("Homepage banner not found.", httpStatus.NOT_FOUND);
  }

  if (Object.hasOwn(req.body || {}, "isActive")) {
    banner.isActive = parseBoolean(req.body.isActive, "isActive");
  }

  if (Object.hasOwn(req.body || {}, "sortOrder")) {
    const parsed = Number(req.body.sortOrder);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new AppError("sortOrder must be a number >= 0.", httpStatus.BAD_REQUEST);
    }
    banner.sortOrder = Math.floor(parsed);
  }

  await banner.save();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Homepage banner updated.",
    data: serializeHomeBanner(banner),
  });
});

/**
 * DELETE /api/v1/home-banners/admin/:bannerId
 */
export const deleteHomeBanner = catchAsync(async (req, res) => {
  const bannerId = parseObjectId(req.params.bannerId, "Banner id");
  const banner = await HomeBanner.findById(bannerId);
  if (!banner) {
    throw new AppError("Homepage banner not found.", httpStatus.NOT_FOUND);
  }

  await deleteBannerImageFromStorage(banner.image);
  await banner.deleteOne();

  res.status(httpStatus.OK).json({
    success: true,
    message: "Homepage photo deleted.",
    data: null,
  });
});
