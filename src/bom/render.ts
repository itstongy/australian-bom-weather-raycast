import { join } from "node:path";
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { PNG } from "pngjs";
import {
  BASE_URL,
  GIF_FRAME_DELAY_MS,
  GIF_TTL_MS,
  RADAR_GIF_CACHE_VERSION,
  RADAR_STALE_AFTER_MS,
} from "./constants";
import {
  atomicWriteFile,
  cacheDir,
  isFresh,
  maybePruneRadarCache,
  RADAR_CACHE_POLICY,
  readCacheFile,
  removeFile,
} from "./cache";
import {
  downloadFrame,
  latestFrameTimeMs,
  scrapeFrames,
  validatePngBuffer,
} from "./frames";
import { HttpGetOptions, HttpStatusError, httpGetBuffer } from "./http";
import { RadarProduct, RadarUnavailableError, RenderResult } from "./types";

type RenderTask = {
  promise: Promise<RenderResult>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
};

type OverlayTask = {
  promise: Promise<PNG | null>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
};

const pendingRenders = new Map<string, RenderTask>();
const pendingOverlays = new Map<string, OverlayTask>();

export async function renderRadarLoop(
  product: RadarProduct,
  frameCount: number,
  options: HttpGetOptions = {},
): Promise<RenderResult> {
  maybePruneRadarCache(RADAR_GIF_CACHE_VERSION);
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    throw new Error("Radar frame count must be a positive integer");
  }
  const renderKey = `${cacheDir()}:${product.id}:${frameCount}:${options.timeoutMs ?? ""}:${options.maxBytes ?? ""}`;
  let task = pendingRenders.get(renderKey);
  if (!task) {
    const controller = new AbortController();
    task = {
      promise: Promise.resolve(null as never),
      controller,
      consumers: 0,
      settled: false,
    };
    const currentTask = task;
    currentTask.promise = renderRadarLoopInner(product, frameCount, {
      ...options,
      signal: controller.signal,
    }).finally(() => {
      currentTask.settled = true;
      if (pendingRenders.get(renderKey) === currentTask) {
        pendingRenders.delete(renderKey);
      }
    });
    pendingRenders.set(renderKey, currentTask);
  }
  return subscribeToRender(renderKey, task, options.signal);
}

function subscribeToRender(
  renderKey: string,
  task: RenderTask,
  signal?: AbortSignal,
) {
  task.consumers += 1;
  return new Promise<RenderResult>((resolve, reject) => {
    let finished = false;
    const finish = (callback: () => void) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      task.consumers -= 1;
      if (task.consumers === 0 && !task.settled) {
        if (pendingRenders.get(renderKey) === task)
          pendingRenders.delete(renderKey);
        task.controller.abort();
      }
      callback();
    };
    const onAbort = () =>
      finish(() => {
        const error = new Error("Radar render aborted");
        error.name = "AbortError";
        reject(error);
      });

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    task.promise.then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function renderRadarLoopInner(
  product: RadarProduct,
  frameCount: number,
  options: HttpGetOptions,
): Promise<RenderResult> {
  const { frames, statusReport } = await scrapeFrames(product, options);
  const selected = frames.slice(-frameCount);
  if (selected.length === 0) {
    throw new RadarUnavailableError(
      product,
      `No radar frames are currently available for ${product.site} ${product.label} (${product.id}). The radar may be offline, under maintenance, or BoM may not have issued this product recently.`,
      statusReport,
    );
  }

  const candidateFrameTime = selected[selected.length - 1]?.timestamp;
  const latestFrameTimestampMs = candidateFrameTime
    ? latestFrameTimeMs(candidateFrameTime)
    : null;
  const latestFrameTime =
    latestFrameTimestampMs === null ? undefined : candidateFrameTime;
  const latestFrameAgeMinutes =
    latestFrameTimestampMs === null
      ? undefined
      : Math.max(0, Math.round((Date.now() - latestFrameTimestampMs) / 60000));
  const freshness =
    latestFrameAgeMinutes === undefined
      ? "unknown"
      : latestFrameAgeMinutes > RADAR_STALE_AFTER_MS / 60000
        ? "stale"
        : "fresh";

  const cacheKey = selected.map((frame) => frame.file).join("_");
  const gifPath = join(
    cacheDir(),
    "gifs",
    product.id,
    `v${RADAR_GIF_CACHE_VERSION}-${frameCount}-${hashString(cacheKey)}.gif`,
  );
  if (isFresh(gifPath, GIF_TTL_MS) && isValidGif(gifPath)) {
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
    selected.map((frame) => downloadFrame(product.id, frame, options)),
  );
  const renderedFrames = await renderFramesWithOverlays(
    product,
    pngPaths,
    options,
  );
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
  options: HttpGetOptions,
) {
  const overlays = await loadOverlays(product.id, options);
  const rendered: PNG[] = [];

  for (const [frameIndex, framePath] of framePaths.entries()) {
    const radar = PNG.sync.read(readCacheFile(framePath));
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
  const data = Buffer.from(gif.bytes());
  if (!isGifBuffer(data))
    throw new Error("Radar GIF encoder returned invalid data");
  atomicWriteFile(path, data);
}

async function loadOverlays(productId: string, options: HttpGetOptions) {
  const [background, locations] = await Promise.all([
    loadOverlay(productId, "background", options),
    loadOverlay(productId, "locations", options),
  ]);

  return { background, locations };
}

async function loadOverlay(
  productId: string,
  feature: string,
  options: HttpGetOptions,
) {
  for (const overlayProductId of overlayProductIds(productId)) {
    const file = `${overlayProductId}.${feature}.png`;
    const path = join(cacheDir(), "_overlays", file);
    const missingPath = `${path}.missing`;

    const cached = readValidPng(path);
    if (cached) return cached;
    if (isFresh(missingPath, RADAR_CACHE_POLICY.negativeOverlayTtlMs)) continue;

    const overlay = await loadOverlayCandidate(
      path,
      missingPath,
      `${BASE_URL}/products/radar_transparencies/${file}`,
      options,
    );
    if (overlay) return overlay;
  }

  return null;
}

export async function loadOverlayCandidate(
  path: string,
  missingPath: string,
  url: string,
  options: HttpGetOptions,
) {
  const taskKey = `${path}:${url}:${options.timeoutMs ?? ""}:${options.maxBytes ?? ""}:${options.maxAttempts ?? ""}:${options.retryBaseDelayMs ?? ""}:${options.retryDelayCapMs ?? ""}`;
  let task = pendingOverlays.get(taskKey);
  if (!task) {
    const controller = new AbortController();
    task = {
      promise: Promise.resolve(null),
      controller,
      consumers: 0,
      settled: false,
    };
    const currentTask = task;
    currentTask.promise = fetchOverlay(path, missingPath, url, {
      ...options,
      signal: controller.signal,
    }).finally(() => {
      currentTask.settled = true;
      if (pendingOverlays.get(taskKey) === currentTask) {
        pendingOverlays.delete(taskKey);
      }
    });
    pendingOverlays.set(taskKey, currentTask);
  }
  return subscribeToOverlay(taskKey, task, options.signal);
}

function subscribeToOverlay(
  taskKey: string,
  task: OverlayTask,
  signal?: AbortSignal,
) {
  task.consumers += 1;
  return new Promise<PNG | null>((resolve, reject) => {
    let finished = false;
    const finish = (callback: () => void) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      task.consumers -= 1;
      if (task.consumers === 0 && !task.settled) {
        if (pendingOverlays.get(taskKey) === task)
          pendingOverlays.delete(taskKey);
        task.controller.abort();
      }
      callback();
    };
    const onAbort = () =>
      finish(() => {
        const error = new Error("Radar overlay download aborted");
        error.name = "AbortError";
        reject(error);
      });

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    task.promise.then(
      (overlay) => finish(() => resolve(overlay)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function fetchOverlay(
  path: string,
  missingPath: string,
  url: string,
  options: HttpGetOptions,
) {
  try {
    const data = await httpGetBuffer(url, options);
    validatePngBuffer(data, url);
    atomicWriteFile(path, data);
    removeFile(missingPath);
    return PNG.sync.read(data);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (error instanceof HttpStatusError && error.status === 404) {
      atomicWriteFile(missingPath, "missing");
    }
    return null;
  }
}

function readValidPng(path: string) {
  try {
    const data = readCacheFile(path);
    validatePngBuffer(data, path);
    return PNG.sync.read(data);
  } catch {
    removeFile(path);
    return null;
  }
}

function isValidGif(path: string) {
  try {
    if (isGifBuffer(readCacheFile(path))) return true;
  } catch {
    // Removed below.
  }
  removeFile(path);
  return false;
}

export function isGifBuffer(data: Buffer) {
  if (data.length < 14) return false;
  const header = data.subarray(0, 6).toString("ascii");
  if (header !== "GIF87a" && header !== "GIF89a") return false;

  const logicalWidth = data.readUInt16LE(6);
  const logicalHeight = data.readUInt16LE(8);
  if (logicalWidth < 1 || logicalHeight < 1) return false;

  let offset = 13;
  const logicalPacked = data[10];
  const hasGlobalColorTable = Boolean(logicalPacked & 0x80);
  if (hasGlobalColorTable) {
    offset += colorTableByteLength(logicalPacked);
    if (offset > data.length) return false;
  }

  let imageCount = 0;
  while (offset < data.length) {
    const marker = data[offset++];
    if (marker === 0x3b) {
      return imageCount > 0 && offset === data.length;
    }
    if (marker === 0x21) {
      if (offset >= data.length) return false;
      const label = data[offset++];
      const nextOffset = skipGifExtension(data, offset, label);
      if (nextOffset === null) return false;
      offset = nextOffset;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > data.length) return false;

    const left = data.readUInt16LE(offset);
    const top = data.readUInt16LE(offset + 2);
    const width = data.readUInt16LE(offset + 4);
    const height = data.readUInt16LE(offset + 6);
    const packed = data[offset + 8];
    offset += 9;
    if (
      width < 1 ||
      height < 1 ||
      left + width > logicalWidth ||
      top + height > logicalHeight
    ) {
      return false;
    }
    const hasLocalColorTable = Boolean(packed & 0x80);
    if (!hasGlobalColorTable && !hasLocalColorTable) return false;
    if (hasLocalColorTable) {
      offset += colorTableByteLength(packed);
      if (offset > data.length) return false;
    }
    if (offset >= data.length) return false;
    const minimumCodeSize = data[offset++];
    if (minimumCodeSize < 2 || minimumCodeSize > 8) return false;
    const imageDataOffset = skipGifSubBlocks(data, offset, true);
    if (imageDataOffset === null) return false;
    offset = imageDataOffset;
    imageCount += 1;
  }
  return false;
}

function skipGifExtension(data: Buffer, start: number, label: number) {
  if (label === 0xf9) {
    if (start >= data.length || data[start] !== 4) return null;
    const terminator = start + 5;
    if (terminator >= data.length || data[terminator] !== 0) return null;
    return terminator + 1;
  }

  if (label === 0xff || label === 0x01) {
    const expectedHeaderSize = label === 0xff ? 11 : 12;
    if (start >= data.length || data[start] !== expectedHeaderSize) return null;
    const subBlocksStart = start + 1 + expectedHeaderSize;
    if (subBlocksStart > data.length) return null;
    return skipGifSubBlocks(data, subBlocksStart);
  }

  // Comments and future extension types consist solely of data sub-blocks.
  return skipGifSubBlocks(data, start);
}

function colorTableByteLength(packed: number) {
  return 3 * 2 ** ((packed & 0x07) + 1);
}

function skipGifSubBlocks(data: Buffer, start: number, requireData = false) {
  let offset = start;
  let sawData = false;
  while (offset < data.length) {
    const length = data[offset++];
    if (length === 0) return !requireData || sawData ? offset : null;
    sawData = true;
    if (offset + length > data.length) return null;
    offset += length;
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
