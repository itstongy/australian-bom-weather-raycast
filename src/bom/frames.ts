import { basename, join } from "node:path";
import { PNG } from "pngjs";
import { BASE_URL, FRAME_INDEX_TTL_MS } from "./constants";
import {
  atomicWriteFile,
  cacheDir,
  readCacheFile,
  readFreshJson,
  readJsonFile,
  removeFile,
  writeJsonFile,
} from "./cache";
import { HttpGetOptions, httpGetBuffer, httpGetText } from "./http";
import { htmlToText } from "./text";
import {
  isRadarFrame,
  RadarFrame,
  RadarProduct,
  RadarUnavailableError,
} from "./types";

type FrameDownloadTask = {
  promise: Promise<string>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
};

export type FrameScrapeOptions = HttpGetOptions & {
  getText?: typeof httpGetText;
  getStatusReport?: (
    product: RadarProduct,
    options: HttpGetOptions,
  ) => Promise<string | undefined>;
};

const pendingFrameDownloads = new Map<string, FrameDownloadTask>();

function isRadarFrameArray(value: unknown): value is RadarFrame[] {
  return Array.isArray(value) && value.every(isRadarFrame);
}

export async function scrapeFrames(
  product: RadarProduct,
  options: FrameScrapeOptions = {},
): Promise<{
  frames: RadarFrame[];
  statusReport?: string;
}> {
  const cachePath = join(cacheDir(), "frame-indexes", `${product.id}.json`);
  const cached = readFreshJson(
    cachePath,
    FRAME_INDEX_TTL_MS,
    isRadarFrameArray,
  );
  if (cached) return { frames: cached };

  const stale = readJsonFile(cachePath, isRadarFrameArray);
  let html: string;
  try {
    html = await (options.getText ?? httpGetText)(product.loopUrl, options);
  } catch (error) {
    if (isAbortError(error)) throw error;
    const statusReport = await loadStatusReport(product, options);
    if (stale) return { frames: stale, statusReport };
    throw new RadarUnavailableError(
      product,
      `Could not load the BoM radar loop page for ${product.site} ${product.label} (${product.id}).`,
      statusReport,
    );
  }

  const deduped = parseRadarFrames(html);
  if (deduped.length === 0) {
    const statusReport = await loadStatusReport(product, options);
    if (stale) return { frames: stale, statusReport };
    throw new RadarUnavailableError(
      product,
      `No radar frames were listed for ${product.site} ${product.label} (${product.id}).`,
      statusReport,
    );
  }

  writeJsonFile(cachePath, deduped);
  return { frames: deduped };
}

export function parseRadarFrames(html: string): RadarFrame[] {
  const frameRegex =
    /theImageNames\[\d+\]\s*=\s*"(?<path>\/radar\/[^"?#]+?\.png)"/g;
  const frames: RadarFrame[] = [];
  let match: RegExpExecArray | null;

  while ((match = frameRegex.exec(html)) !== null) {
    const path = match.groups?.path ?? "";
    const timestamp = path.match(/\.(\d{12})\./)?.[1];
    frames.push({
      url: `${BASE_URL}${path}`,
      file: basename(path),
      timestamp,
    });
  }

  return dedupeFrames(frames);
}

export async function downloadFrame(
  productId: string,
  frame: RadarFrame,
  options: HttpGetOptions = {},
) {
  if (!/^IDR[A-Z0-9]+$/.test(productId)) {
    throw new Error(`Invalid radar product ID: ${productId}`);
  }
  if (!/^[A-Za-z0-9._-]+\.png$/.test(frame.file)) {
    throw new Error(`Invalid radar frame filename: ${frame.file}`);
  }
  const path = join(cacheDir(), "frames", productId, frame.file);
  if (readValidPng(path)) return path;

  const taskKey = `${cacheDir()}:${path}:${options.timeoutMs ?? ""}:${options.maxBytes ?? ""}`;
  let task = pendingFrameDownloads.get(taskKey);
  if (!task) {
    const controller = new AbortController();
    task = {
      promise: Promise.resolve(null as never),
      controller,
      consumers: 0,
      settled: false,
    };
    const currentTask = task;
    currentTask.promise = downloadAndStoreFrame(path, frame.url, {
      ...options,
      signal: controller.signal,
    }).finally(() => {
      currentTask.settled = true;
      if (pendingFrameDownloads.get(taskKey) === currentTask) {
        pendingFrameDownloads.delete(taskKey);
      }
    });
    pendingFrameDownloads.set(taskKey, currentTask);
  }
  return subscribeToFrameDownload(taskKey, task, options.signal);
}

function subscribeToFrameDownload(
  taskKey: string,
  task: FrameDownloadTask,
  signal?: AbortSignal,
) {
  task.consumers += 1;
  return new Promise<string>((resolve, reject) => {
    let finished = false;
    const finish = (callback: () => void) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      task.consumers -= 1;
      if (task.consumers === 0 && !task.settled) {
        if (pendingFrameDownloads.get(taskKey) === task) {
          pendingFrameDownloads.delete(taskKey);
        }
        task.controller.abort();
      }
      callback();
    };
    const onAbort = () =>
      finish(() => {
        const error = new Error("Radar frame download aborted");
        error.name = "AbortError";
        reject(error);
      });

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    task.promise.then(
      (path) => finish(() => resolve(path)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function downloadAndStoreFrame(
  path: string,
  url: string,
  options: HttpGetOptions,
) {
  const data = await httpGetBuffer(url, options);
  validatePngBuffer(data, url);
  atomicWriteFile(path, data);
  return path;
}

export async function fetchRadarStatusReport(
  product: RadarProduct,
  options: HttpGetOptions = {},
) {
  const radarId = radarSiteId(product.id);
  if (!radarId) return undefined;

  try {
    const html = await httpGetText(
      `${BASE_URL}/radar/IDR999${radarId}.html`,
      options,
    );
    if (html.includes("page you requested was not found")) return undefined;
    return htmlToText(html);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

export function latestFrameTimeMs(timestamp: string): number | null {
  const match = timestamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const parts = [year, month, day, hour, minute].map(Number);
  const timestampMs = Date.UTC(
    parts[0],
    parts[1] - 1,
    parts[2],
    parts[3],
    parts[4],
  );
  const parsed = new Date(timestampMs);
  if (
    parsed.getUTCFullYear() !== parts[0] ||
    parsed.getUTCMonth() !== parts[1] - 1 ||
    parsed.getUTCDate() !== parts[2] ||
    parsed.getUTCHours() !== parts[3] ||
    parsed.getUTCMinutes() !== parts[4]
  ) {
    return null;
  }
  return timestampMs;
}

export function validatePngBuffer(data: Buffer, source = "radar image") {
  if (
    data.length < 24 ||
    !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error(`Invalid PNG response from ${source}`);
  }
  try {
    const decoded = PNG.sync.read(data);
    if (decoded.width < 1 || decoded.height < 1) throw new Error("empty PNG");
  } catch (error) {
    throw new Error(`Invalid PNG response from ${source}`, { cause: error });
  }
}

function readValidPng(path: string) {
  try {
    const data = readCacheFile(path);
    validatePngBuffer(data, path);
    return data;
  } catch {
    removeFile(path);
    return null;
  }
}

function loadStatusReport(product: RadarProduct, options: FrameScrapeOptions) {
  return options.getStatusReport
    ? options.getStatusReport(product, options)
    : fetchRadarStatusReport(product, options);
}

function dedupeFrames(frames: RadarFrame[]) {
  const seen = new Set<string>();
  return frames.filter((frame) => {
    if (seen.has(frame.url)) return false;
    seen.add(frame.url);
    return true;
  });
}

function radarSiteId(productId: string) {
  const match = productId.match(/^IDR(\d+|[0-9]+[A-Z])$/);
  if (!match) return null;
  const code = match[1];
  const numericPrefix = code.match(/^\d+/)?.[0];
  if (!numericPrefix) return null;
  const site = code.match(/[A-Z]$/)
    ? numericPrefix
    : numericPrefix.slice(0, -1);
  if (!site) return null;
  return site.padStart(3, "0");
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
