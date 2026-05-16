import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

let cacheBaseDir = join(homedir(), ".cache", "bom-weather-radar-raycast");

export function setCacheBaseDir(path: string) {
  cacheBaseDir = path;
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
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeJsonFile(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

export function isFresh(path: string, ttlMs: number) {
  if (!existsSync(path)) return false;
  try {
    return Date.now() - statSync(path).mtimeMs < ttlMs;
  } catch {
    return false;
  }
}
