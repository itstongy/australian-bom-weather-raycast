import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Client } from "basic-ftp";
import {
  BASE_URL,
  FRAME_INDEX_TTL_MS,
  FTP_HOST,
  FTP_RADAR_DIR,
} from "./constants";
import { cacheDir, readFreshJson, readJsonFile, writeJsonFile } from "./cache";
import { httpGetBuffer, httpGetText } from "./http";
import { htmlToText } from "./text";
import {
  isRadarFrame,
  RadarFrame,
  RadarProduct,
  RadarUnavailableError,
} from "./types";

function isRadarFrameArray(value: unknown): value is RadarFrame[] {
  return Array.isArray(value) && value.every(isRadarFrame);
}

export async function scrapeFrames(product: RadarProduct): Promise<{
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
  const statusReport = await fetchRadarStatusReport(product);

  try {
    const frames = await listFramesFromFtp(product);
    if (frames.length > 0) {
      writeJsonFile(cachePath, frames);
      return { frames, statusReport };
    }
  } catch {
    // Fall back to the legacy loop page source below.
  }

  let html: string;
  try {
    html = await httpGetText(product.loopUrl);
  } catch {
    if (stale) return { frames: stale, statusReport };
    throw new RadarUnavailableError(
      product,
      `Could not load the BoM radar loop page for ${product.site} ${product.label} (${product.id}).`,
      statusReport,
    );
  }
  const frameRegex =
    /theImageNames\[\d+\]\s*=\s*"(?<path>\/radar\/[^"]+?\.png)"/g;
  const frames: RadarFrame[] = [];
  let match;

  while ((match = frameRegex.exec(html)) !== null) {
    const path = match.groups?.path ?? "";
    const timestamp = path.match(/\.(\d{12})\./)?.[1];
    frames.push({
      url: `${BASE_URL}${path}`,
      file: basename(path),
      timestamp,
    });
  }

  const deduped = dedupeFrames(frames);
  if (deduped.length === 0 && stale) return { frames: stale, statusReport };
  writeJsonFile(cachePath, deduped);
  return { frames: deduped, statusReport };
}

async function listFramesFromFtp(product: RadarProduct): Promise<RadarFrame[]> {
  const client = new Client(15000);
  try {
    await client.access({ host: FTP_HOST });
    const entries = await client.list(FTP_RADAR_DIR);
    return entries
      .map((entry) => radarFrameFromFtpName(product.id, entry.name))
      .filter((frame): frame is RadarFrame => Boolean(frame))
      .sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
  } finally {
    client.close();
  }
}

export function radarFrameFromFtpName(
  productId: string,
  name: string,
): RadarFrame | null {
  const escapedProductId = productId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = name.match(
    new RegExp(`^${escapedProductId}\\.T\\.(?<timestamp>\\d{12})\\.png$`),
  );
  if (!match) return null;

  return {
    url: `${BASE_URL}/radar/${name}`,
    file: name,
    timestamp: match.groups?.timestamp,
  };
}

export async function downloadFrame(productId: string, frame: RadarFrame) {
  const path = join(cacheDir(), productId, frame.file);
  mkdirSync(dirname(path), { recursive: true });
  try {
    readFileSync(path);
    return path;
  } catch {
    const data = await httpGetBuffer(frame.url);
    writeFileSync(path, data);
    return path;
  }
}

export async function fetchRadarStatusReport(product: RadarProduct) {
  const radarId = radarSiteId(product.id);
  if (!radarId) return undefined;

  try {
    const html = await httpGetText(`${BASE_URL}/radar/IDR999${radarId}.html`);
    if (html.includes("page you requested was not found")) return undefined;
    return htmlToText(html);
  } catch {
    return undefined;
  }
}

export function latestFrameTimeMs(timestamp: string) {
  const match = timestamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return Date.now();
  const [, year, month, day, hour, minute] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
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
