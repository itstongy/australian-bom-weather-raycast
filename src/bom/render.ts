import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { PNG } from "pngjs";
import {
  BASE_URL,
  GIF_FRAME_DELAY_MS,
  GIF_TTL_MS,
  RADAR_STALE_AFTER_MS,
} from "./constants";
import { cacheDir, isFresh } from "./cache";
import { downloadFrame, latestFrameTimeMs, scrapeFrames } from "./frames";
import { httpGetBuffer } from "./http";
import { RadarProduct, RadarUnavailableError, RenderResult } from "./types";

const RADAR_GIF_CACHE_VERSION = 3;

export async function renderRadarLoop(
  product: RadarProduct,
  frameCount: number,
): Promise<RenderResult> {
  const { frames, statusReport } = await scrapeFrames(product);
  const selected = frames.slice(-frameCount);
  if (selected.length === 0) {
    throw new RadarUnavailableError(
      product,
      `No radar frames are currently available for ${product.site} ${product.label} (${product.id}). The radar may be offline, under maintenance, or BoM may not have issued this product recently.`,
      statusReport,
    );
  }

  const latestFrameTime = selected[selected.length - 1]?.timestamp;
  const latestFrameAgeMinutes = latestFrameTime
    ? Math.max(
        0,
        Math.round((Date.now() - latestFrameTimeMs(latestFrameTime)) / 60000),
      )
    : undefined;
  const freshness =
    latestFrameAgeMinutes !== undefined &&
    latestFrameAgeMinutes > RADAR_STALE_AFTER_MS / 60000
      ? "stale"
      : "fresh";

  const cacheKey = selected.map((frame) => frame.file).join("_");
  const gifPath = join(
    cacheDir(),
    "gifs",
    product.id,
    `v${RADAR_GIF_CACHE_VERSION}-${frameCount}-${hashString(cacheKey)}.gif`,
  );
  if (isFresh(gifPath, GIF_TTL_MS)) {
    return {
      gifPath,
      frames: selected.length,
      product,
      freshness,
      latestFrameTime,
      latestFrameAgeMinutes,
      statusReport,
    };
  }

  const pngPaths = await Promise.all(
    selected.map((frame) => downloadFrame(product.id, frame)),
  );
  const renderedFrames = await renderFramesWithOverlays(product, pngPaths);
  writeGif(gifPath, renderedFrames);

  return {
    gifPath,
    frames: selected.length,
    product,
    freshness,
    latestFrameTime,
    latestFrameAgeMinutes,
    statusReport,
  };
}

async function renderFramesWithOverlays(
  product: RadarProduct,
  framePaths: string[],
) {
  const overlays = await loadOverlays(product.id);
  const rendered: PNG[] = [];

  for (const [frameIndex, framePath] of framePaths.entries()) {
    const radar = PNG.sync.read(readFileSync(framePath));
    const out = new PNG({ width: radar.width, height: radar.height });
    out.data.fill(0);

    if (overlays.background && sameSize(overlays.background, out))
      alphaOver(out, overlays.background);
    alphaOver(out, radar);
    if (overlays.locations && sameSize(overlays.locations, out))
      alphaOver(out, overlays.locations);

    addLoopProgressBar(out, frameIndex, framePaths.length);
    rendered.push(out);
  }

  return rendered;
}

export function addLoopProgressBar(
  frame: PNG,
  frameIndex: number,
  frameCount: number,
) {
  const trackHeight = Math.max(4, Math.round(frame.height * 0.014));
  const trackTop = Math.max(
    0,
    Math.min(
      frame.height - trackHeight,
      Math.max(12, Math.round(frame.height * 0.03)),
    ),
  );
  const fillHeight = Math.max(2, Math.round(trackHeight * 0.55));
  const fillTop = Math.floor((trackHeight - fillHeight) / 2);
  const progress = frameCount <= 1 ? 1 : frameIndex / (frameCount - 1);
  const fillWidth = Math.round(frame.width * progress);

  for (let y = 0; y < trackHeight; y++) {
    for (let x = 0; x < frame.width; x++) {
      const offset = ((trackTop + y) * frame.width + x) * 4;
      blendPixel(frame.data, offset, 0, 0, 0, 180);

      if (y >= fillTop && y < fillTop + fillHeight && x < fillWidth) {
        blendPixel(frame.data, offset, 255, 59, 48, 255);
      }
    }
  }
}

function writeGif(path: string, frames: PNG[]) {
  if (frames.length === 0) throw new Error("No rendered frames to encode");
  mkdirSync(dirname(path), { recursive: true });

  const gif = GIFEncoder();
  for (const frame of frames) {
    const palette = quantize(frame.data, 256);
    const index = applyPalette(frame.data, palette);
    gif.writeFrame(index, frame.width, frame.height, {
      palette,
      delay: GIF_FRAME_DELAY_MS,
      repeat: 0,
    });
  }
  gif.finish();
  writeFileSync(path, Buffer.from(gif.bytes()));
}

async function loadOverlays(productId: string) {
  const [background, locations] = await Promise.all([
    loadOverlay(productId, "background"),
    loadOverlay(productId, "locations"),
  ]);

  return { background, locations };
}

async function loadOverlay(productId: string, feature: string) {
  for (const overlayProductId of overlayProductIds(productId)) {
    const file = `${overlayProductId}.${feature}.png`;
    const path = join(cacheDir(), "_overlays", file);
    mkdirSync(dirname(path), { recursive: true });

    try {
      return PNG.sync.read(readFileSync(path));
    } catch {
      try {
        const data = await httpGetBuffer(
          `${BASE_URL}/products/radar_transparencies/${file}`,
        );
        writeFileSync(path, data);
        return PNG.sync.read(data);
      } catch {
        // Try the next overlay product fallback.
      }
    }
  }

  return null;
}

function sameSize(a: PNG, b: PNG) {
  return a.width === b.width && a.height === b.height;
}

function alphaOver(dst: PNG, src: PNG) {
  for (let i = 0; i < dst.data.length; i += 4) {
    const sa = src.data[i + 3] / 255;
    if (sa === 0) continue;

    const sr = src.data[i];
    const sg = src.data[i + 1];
    const sb = src.data[i + 2];
    const dr = dst.data[i];
    const dg = dst.data[i + 1];
    const db = dst.data[i + 2];
    const da = dst.data[i + 3] / 255;
    const outA = sa + da * (1 - sa);

    dst.data[i] = Math.round((sr * sa + dr * da * (1 - sa)) / (outA || 1));
    dst.data[i + 1] = Math.round((sg * sa + dg * da * (1 - sa)) / (outA || 1));
    dst.data[i + 2] = Math.round((sb * sa + db * da * (1 - sa)) / (outA || 1));
    dst.data[i + 3] = Math.round(outA * 255);
  }
}

function blendPixel(
  data: Buffer,
  offset: number,
  red: number,
  green: number,
  blue: number,
  alpha: number,
) {
  const sourceAlpha = alpha / 255;
  const destinationAlpha = data[offset + 3] / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);

  data[offset] = Math.round(
    (red * sourceAlpha + data[offset] * destinationAlpha * (1 - sourceAlpha)) /
      (outputAlpha || 1),
  );
  data[offset + 1] = Math.round(
    (green * sourceAlpha +
      data[offset + 1] * destinationAlpha * (1 - sourceAlpha)) /
      (outputAlpha || 1),
  );
  data[offset + 2] = Math.round(
    (blue * sourceAlpha +
      data[offset + 2] * destinationAlpha * (1 - sourceAlpha)) /
      (outputAlpha || 1),
  );
  data[offset + 3] = Math.round(outputAlpha * 255);
}

function overlayProductIds(productId: string) {
  const ids = [productId];
  const fallback = baseOverlayProductId(productId);
  if (fallback && !ids.includes(fallback)) ids.push(fallback);
  return ids;
}

export function baseOverlayProductId(productId: string) {
  const alphaMatch = productId.match(/^IDR(\d+)[A-Z]$/);
  if (alphaMatch) return `IDR${alphaMatch[1]}3`;

  const numericMatch = productId.match(/^IDR(\d+)([1-4])$/);
  if (numericMatch) return `IDR${numericMatch[1]}3`;

  return null;
}

function hashString(value: string) {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
