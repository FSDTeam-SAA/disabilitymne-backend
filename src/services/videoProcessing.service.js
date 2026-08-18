import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const asString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const isVideoStripAudioEnabled = () => {
  const flag = asString(process.env.STRIP_EXERCISE_VIDEO_AUDIO).toLowerCase();
  return flag !== "false" && flag !== "0" && flag !== "no";
};

let ffmpegAvailabilityPromise = null;

const isFfmpegAvailable = async () => {
  if (!ffmpegAvailabilityPromise) {
    ffmpegAvailabilityPromise = execFileAsync("ffmpeg", ["-version"])
      .then(() => true)
      .catch(() => false);
  }

  return ffmpegAvailabilityPromise;
};

const buildProcessedOutputPath = (inputPath) => {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}.no-audio${parsed.ext || ".mp4"}`);
};

const runFfmpegStripAudio = async (inputPath, outputPath) => {
  try {
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", inputPath, "-c:v", "copy", "-an", outputPath],
      { timeout: 300000 }
    );
    return true;
  } catch {
    await fs.unlink(outputPath).catch(() => {});
  }

  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-an",
        outputPath,
      ],
      { timeout: 600000 }
    );
    return true;
  } catch {
    await fs.unlink(outputPath).catch(() => {});
    return false;
  }
};

/**
 * Removes audio tracks from a local video file before upload.
 * Returns the original path when stripping is disabled or ffmpeg is unavailable.
 */
export const stripAudioFromVideoFile = async (inputPath) => {
  const normalizedInputPath = asString(inputPath);
  if (!normalizedInputPath || !isVideoStripAudioEnabled()) {
    return { outputPath: normalizedInputPath, audioStripped: false };
  }

  if (!(await isFfmpegAvailable())) {
    console.warn("[videoProcessing] ffmpeg is not available; uploading video without audio stripping.");
    return { outputPath: normalizedInputPath, audioStripped: false };
  }

  const outputPath = buildProcessedOutputPath(normalizedInputPath);
  const success = await runFfmpegStripAudio(normalizedInputPath, outputPath);
  if (!success) {
    console.warn("[videoProcessing] Failed to strip audio; uploading original video file.");
    return { outputPath: normalizedInputPath, audioStripped: false };
  }

  return { outputPath, audioStripped: true };
};

export const cleanupProcessedVideoFile = async (processedPath, originalPath) => {
  const normalizedProcessedPath = asString(processedPath);
  const normalizedOriginalPath = asString(originalPath);

  if (!normalizedProcessedPath || normalizedProcessedPath === normalizedOriginalPath) {
    return;
  }

  await fs.unlink(normalizedProcessedPath).catch(() => {});
};
