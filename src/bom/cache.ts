import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import crypto from "node:crypto";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

let cacheBaseDir = join(homedir(), ".cache", "bom-weather-radar-raycast");
let lastPrunedBaseDir = "";
let lastPrunedAt = 0;

export const RADAR_CACHE_POLICY = {
  pruneIntervalMs: 10 * 60 * 1000,
  orphanTempMaxAgeMs: 30 * 60 * 1000,
  rawFrameMaxAgeMs: 6 * 60 * 60 * 1000,
  rawFramesPerProduct: 48,
  gifMaxAgeMs: 2 * 60 * 60 * 1000,
  gifsPerProduct: 8,
  frameIndexMaxAgeMs: 24 * 60 * 60 * 1000,
  frameIndexesMaxCount: 128,
  overlayMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
  overlaysMaxCount: 256,
  negativeOverlayTtlMs: 10 * 60 * 1000,
  catalogMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
} as const;

export function setCacheBaseDir(path: string) {
  cacheBaseDir = resolve(path);
  lastPrunedBaseDir = "";
  lastPrunedAt = 0;
}

export function cacheDir() {
  return cacheBaseDir;
}

export function readFreshJson<T>(
  path: string,
  ttlMs: number,
  validate: (value: unknown) => value is T,
): T | null {
  if (!isFresh(path, ttlMs)) return null;
  return readJsonFile(path, validate);
}

export function readJsonFile<T>(
  path: string,
  validate: (value: unknown) => value is T,
): T | null {
  try {
    const parsed = JSON.parse(readCacheFile(path).toString("utf8")) as unknown;
    if (validate(parsed)) return parsed;
  } catch {
    // Invalid cache entries are removed below and rebuilt by their caller.
  }
  removeFile(path);
  return null;
}

export type JsonFileSnapshot<T> = {
  data: T;
  mtimeMs: number;
  identity: { dev: number; ino: number };
};

/**
 * Reads JSON and its file metadata from one open file descriptor. Atomic cache
 * replacement can otherwise pair an old payload with the replacement file's
 * fresh mtime when callers read and stat the pathname separately.
 */
export function readJsonFileSnapshot<T>(
  path: string,
  validate: (value: unknown) => value is T,
): JsonFileSnapshot<T> | null {
  const maxReadAttempts = 2;

  for (let attempt = 0; attempt < maxReadAttempts; attempt += 1) {
    let descriptor: number | undefined;
    try {
      const expected = safeCacheFileStat(path);
      if (!expected) return null;
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
      const before = fstatSync(descriptor);
      if (
        !before.isFile() ||
        before.dev !== expected.dev ||
        before.ino !== expected.ino
      ) {
        continue;
      }

      const parsed = JSON.parse(
        readFileSync(descriptor).toString("utf8"),
      ) as unknown;
      const after = fstatSync(descriptor);
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs
      ) {
        continue;
      }
      if (!validate(parsed)) return null;
      return {
        data: parsed,
        mtimeMs: after.mtimeMs,
        identity: { dev: after.dev, ino: after.ino },
      };
    } catch {
      // Missing files and atomic rename races are treated as cache misses.
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // The descriptor is already unusable.
        }
      }
    }
  }
  return null;
}

export function readCacheFile(path: string) {
  if (!safeCacheFileStat(path)) {
    throw new Error(`Refusing to read an unsafe radar cache file: ${path}`);
  }
  return readFileSync(path);
}

export function writeJsonFile(path: string, value: unknown) {
  atomicWriteFile(path, JSON.stringify(value));
}

export function atomicWriteFile(path: string, value: string | Buffer) {
  const directory = dirname(path);
  ensureSafeCacheDirectory(directory);
  const data = typeof value === "string" ? Buffer.from(value) : value;
  const maxCreateAttempts = 8;

  for (let attempt = 0; attempt < maxCreateAttempts; attempt++) {
    const temporaryPath = join(
      directory,
      `.${basename(path)}.tmp-${process.pid}-${crypto.randomBytes(16).toString("hex")}`,
    );
    let descriptor: number | undefined;
    let createdIdentity: { dev: number; ino: number } | undefined;
    try {
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      descriptor = openSync(
        temporaryPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          noFollow,
        0o600,
      );
      const opened = fstatSync(descriptor);
      if (!opened.isFile()) {
        throw new Error(
          `Radar cache temporary path is not a file: ${temporaryPath}`,
        );
      }
      createdIdentity = { dev: opened.dev, ino: opened.ino };
      const linked = lstatSync(temporaryPath);
      if (
        linked.isSymbolicLink() ||
        !linked.isFile() ||
        linked.dev !== opened.dev ||
        linked.ino !== opened.ino
      ) {
        throw new Error(
          `Radar cache temporary file changed during creation: ${temporaryPath}`,
        );
      }

      fchmodSync(descriptor, 0o600);
      let written = 0;
      while (written < data.length) {
        written += writeSync(descriptor, data, written, data.length - written);
      }
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;

      if (!sameFileIdentity(temporaryPath, createdIdentity)) {
        throw new Error(
          `Radar cache temporary file changed before rename: ${temporaryPath}`,
        );
      }
      ensureSafeCacheDirectory(directory);
      renameSync(temporaryPath, path);
      return;
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // The original write failure is more useful.
        }
      }
      if (createdIdentity)
        removeCreatedTemporaryFile(temporaryPath, createdIdentity);
      const code = (error as NodeJS.ErrnoException).code;
      if (!createdIdentity && (code === "EEXIST" || code === "ELOOP")) continue;
      throw error;
    }
  }

  throw new Error(
    `Could not create an exclusive radar cache temporary file for ${path}`,
  );
}

function sameFileIdentity(
  path: string,
  identity: { dev: number; ino: number },
) {
  try {
    const stat = lstatSync(path);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.dev === identity.dev &&
      stat.ino === identity.ino
    );
  } catch {
    return false;
  }
}

function removeCreatedTemporaryFile(
  path: string,
  identity: { dev: number; ino: number },
) {
  try {
    if (sameFileIdentity(path, identity)) unlinkSync(path);
  } catch {
    // A concurrently removed temporary file is already clean.
  }
}

export function isFresh(path: string, ttlMs: number) {
  const age = fileAgeMs(path);
  return age !== null && age >= 0 && age < ttlMs;
}

export function fileAgeMs(path: string, now = Date.now()) {
  try {
    const stat = safeCacheFileStat(path);
    return stat ? now - stat.mtimeMs : null;
  } catch {
    return null;
  }
}

export function removeFile(path: string) {
  try {
    if (!safeCacheFileStat(path)) return;
    unlinkSync(path);
  } catch {
    // Missing and concurrently-pruned cache files are already clean.
  }
}

export function maybePruneRadarCache(currentGifVersion: number) {
  const now = Date.now();
  if (
    lastPrunedBaseDir === cacheBaseDir &&
    now - lastPrunedAt < RADAR_CACHE_POLICY.pruneIntervalMs
  ) {
    return;
  }
  pruneRadarCache(currentGifVersion, now);
  lastPrunedBaseDir = cacheBaseDir;
  lastPrunedAt = now;
}

export function pruneRadarCache(currentGifVersion: number, now = Date.now()) {
  if (!safeCacheRoot()) return;
  pruneProductDirectories(
    join(cacheBaseDir, "frames"),
    ".png",
    RADAR_CACHE_POLICY.rawFrameMaxAgeMs,
    RADAR_CACHE_POLICY.rawFramesPerProduct,
    now,
  );

  // Versions before the bounded frames/ hierarchy stored products at cache root.
  for (const entry of safeReadDir(cacheBaseDir)) {
    if (!entry.isDirectory() || !/^IDR[A-Z0-9]+$/.test(entry.name)) continue;
    pruneFiles(
      join(cacheBaseDir, entry.name),
      (name) => name.endsWith(".png"),
      RADAR_CACHE_POLICY.rawFrameMaxAgeMs,
      RADAR_CACHE_POLICY.rawFramesPerProduct,
      now,
    );
    removeEmptyDirectory(join(cacheBaseDir, entry.name));
  }

  const gifsRoot = join(cacheBaseDir, "gifs");
  for (const product of safeReadDir(gifsRoot)) {
    if (!product.isDirectory()) continue;
    const productPath = join(gifsRoot, product.name);
    for (const file of safeReadDir(productPath)) {
      if (!file.isFile() || !file.name.endsWith(".gif")) continue;
      if (!file.name.startsWith(`v${currentGifVersion}-`)) {
        removeFile(join(productPath, file.name));
      }
    }
    pruneFiles(
      productPath,
      (name) => name.endsWith(".gif"),
      RADAR_CACHE_POLICY.gifMaxAgeMs,
      RADAR_CACHE_POLICY.gifsPerProduct,
      now,
    );
    pruneOrphanTemps(productPath, now);
    removeEmptyDirectory(productPath);
  }

  pruneFiles(
    join(cacheBaseDir, "frame-indexes"),
    (name) => name.endsWith(".json"),
    RADAR_CACHE_POLICY.frameIndexMaxAgeMs,
    RADAR_CACHE_POLICY.frameIndexesMaxCount,
    now,
  );
  pruneFiles(
    join(cacheBaseDir, "_overlays"),
    (name) => name.endsWith(".png"),
    RADAR_CACHE_POLICY.overlayMaxAgeMs,
    RADAR_CACHE_POLICY.overlaysMaxCount,
    now,
  );
  pruneFiles(
    join(cacheBaseDir, "_overlays"),
    (name) => name.endsWith(".missing"),
    RADAR_CACHE_POLICY.negativeOverlayTtlMs,
    RADAR_CACHE_POLICY.overlaysMaxCount,
    now,
  );

  const catalog = join(cacheBaseDir, "radar-products.json");
  const catalogAge = fileAgeMs(catalog, now);
  if (catalogAge !== null && catalogAge > RADAR_CACHE_POLICY.catalogMaxAgeMs) {
    removeFile(catalog);
  }

  for (const directory of [
    cacheBaseDir,
    join(cacheBaseDir, "frames"),
    join(cacheBaseDir, "frame-indexes"),
    join(cacheBaseDir, "_overlays"),
  ]) {
    pruneOrphanTemps(directory, now);
  }
}

function pruneProductDirectories(
  root: string,
  extension: string,
  maxAgeMs: number,
  maxCount: number,
  now: number,
) {
  for (const entry of safeReadDir(root)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    pruneFiles(
      path,
      (name) => name.endsWith(extension),
      maxAgeMs,
      maxCount,
      now,
    );
    pruneOrphanTemps(path, now);
    removeEmptyDirectory(path);
  }
}

function pruneFiles(
  directory: string,
  include: (name: string) => boolean,
  maxAgeMs: number,
  maxCount: number,
  now: number,
) {
  const files = safeReadDir(directory)
    .filter((entry) => entry.isFile() && include(entry.name))
    .map((entry) => {
      const path = join(directory, entry.name);
      try {
        const stat = safeCacheFileStat(path);
        return stat ? { path, mtimeMs: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { path: string; mtimeMs: number } =>
      Boolean(entry),
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  files.forEach((file, index) => {
    if (now - file.mtimeMs > maxAgeMs || index >= maxCount)
      removeFile(file.path);
  });
}

function pruneOrphanTemps(directory: string, now: number) {
  pruneFiles(
    directory,
    (name) => name.includes(".tmp-"),
    RADAR_CACHE_POLICY.orphanTempMaxAgeMs,
    Number.MAX_SAFE_INTEGER,
    now,
  );
}

function safeReadDir(path: string) {
  try {
    if (!safeCacheDirectory(path)) return [];
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function removeEmptyDirectory(path: string) {
  try {
    if (!safeCacheDirectory(path)) return;
    if (readdirSync(path).length === 0) {
      // Re-check immediately before deletion so a swapped symlink is rejected.
      if (!safeCacheDirectory(path)) return;
      rmdirSync(path);
    }
  } catch {
    // A concurrent writer may have populated it.
  }
}

function safeCacheRoot() {
  try {
    const stat = lstatSync(cacheBaseDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return realpathSync(cacheBaseDir);
  } catch {
    return null;
  }
}

function isWithinCache(path: string, root: string) {
  const difference = relative(root, path);
  return (
    difference === "" ||
    (!difference.startsWith("..") && !isAbsolute(difference))
  );
}

function safeCacheDirectory(path: string) {
  try {
    const root = safeCacheRoot();
    if (!root) return null;
    const lexicalPath = resolve(path);
    if (!isWithinCache(lexicalPath, resolve(cacheBaseDir))) return null;
    const stat = lstatSync(lexicalPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const actualPath = realpathSync(lexicalPath);
    return isWithinCache(actualPath, root) ? actualPath : null;
  } catch {
    return null;
  }
}

function safeCacheFileStat(path: string) {
  try {
    const root = safeCacheRoot();
    if (!root) return null;
    const lexicalPath = resolve(path);
    if (!isWithinCache(lexicalPath, resolve(cacheBaseDir))) return null;
    const stat = lstatSync(lexicalPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const actualPath = realpathSync(lexicalPath);
    if (!isWithinCache(actualPath, root)) return null;
    return stat;
  } catch {
    return null;
  }
}

function ensureSafeCacheDirectory(path: string) {
  const lexicalRoot = resolve(cacheBaseDir);
  const target = resolve(path);
  if (!isWithinCache(target, lexicalRoot)) {
    throw new Error(`Refusing to write outside the radar cache: ${target}`);
  }

  mkdirSync(lexicalRoot, { recursive: true });
  if (!safeCacheRoot()) {
    throw new Error(
      `Refusing to use a symlinked radar cache root: ${lexicalRoot}`,
    );
  }

  const difference = relative(lexicalRoot, target);
  let current = lexicalRoot;
  for (const part of difference.split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current);
    if (!safeCacheDirectory(current)) {
      throw new Error(
        `Refusing to use a symlinked radar cache directory: ${current}`,
      );
    }
  }
}
