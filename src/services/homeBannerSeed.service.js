import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HomeBanner } from "../models/homeBanner.model.js";
import { uploadImageFileToR2 } from "./r2.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_HOME_BANNER_FILENAME = "welcome_programs_card.png";
export const DEFAULT_HOME_BANNER_PATH = path.join(
  __dirname,
  "../assets/home-banners",
  DEFAULT_HOME_BANNER_FILENAME
);
const HOME_BANNER_FOLDER = "home-banners";

export const seedDefaultHomeBannerIfEmpty = async () => {
  const existingCount = await HomeBanner.countDocuments();
  if (existingCount > 0) {
    return { seeded: false, reason: "already-exists" };
  }

  await fs.access(DEFAULT_HOME_BANNER_PATH);
  const stat = await fs.stat(DEFAULT_HOME_BANNER_PATH);

  const asset = await uploadImageFileToR2(
    {
      path: DEFAULT_HOME_BANNER_PATH,
      mimetype: "image/png",
      originalname: DEFAULT_HOME_BANNER_FILENAME,
      size: stat.size,
    },
    { folder: HOME_BANNER_FOLDER }
  );

  const banner = await HomeBanner.create({
    image: {
      url: asset.url,
      publicId: asset.publicId,
      mimetype: asset.mimetype,
      size: asset.size,
    },
    sortOrder: 0,
    isActive: true,
  });

  return {
    seeded: true,
    reason: "created",
    id: String(banner._id),
    imageUrl: banner.image?.url || "",
  };
};
