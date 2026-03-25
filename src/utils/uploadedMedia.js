import { toPublicMediaUrl } from "./publicMediaUrl.js";

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

export const toUploadedMediaAsset = (file) => {
  if (!file || typeof file !== "object") {
    return null;
  }

  const url = toPublicMediaUrl(file.path || file.secure_url || file.url);
  if (!url) {
    return null;
  }

  const size = Number(file.size);

  return {
    url,
    publicId: asString(file.filename || file.public_id || file.asset_id),
    mimetype: asString(file.mimetype),
    size: Number.isFinite(size) && size > 0 ? size : 0,
  };
};

const normalizeUploadedFiles = (files) => {
  if (!files) {
    return {};
  }

  if (Array.isArray(files)) {
    return files.reduce((acc, file) => {
      const fieldName = asString(file?.fieldname);
      if (!fieldName) {
        return acc;
      }

      if (!acc[fieldName]) {
        acc[fieldName] = [];
      }

      acc[fieldName].push(file);
      return acc;
    }, {});
  }

  return files;
};

export const getUploadedMediaList = (files, fieldNames = []) => {
  const groupedFiles = normalizeUploadedFiles(files);
  const uploadedMedia = [];

  for (const fieldName of fieldNames) {
    for (const file of groupedFiles[fieldName] || []) {
      const asset = toUploadedMediaAsset(file);
      if (asset) {
        uploadedMedia.push(asset);
      }
    }
  }

  return uploadedMedia;
};

export const mergeUploadedMediaIntoBody = (body, files, mappings = []) => {
  const nextBody = { ...(body || {}) };

  for (const mapping of mappings) {
    const uploadedMedia = getUploadedMediaList(files, mapping.fieldNames || []);
    if (uploadedMedia.length > 0) {
      nextBody[mapping.target] = uploadedMedia;
    }
  }

  return nextBody;
};
