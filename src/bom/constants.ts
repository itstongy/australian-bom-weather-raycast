export const BASE_URL = "https://reg.bom.gov.au";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 BOMWeatherRaycast/0.1";

export const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const FRAME_INDEX_TTL_MS = 3 * 60 * 1000;
export const GIF_TTL_MS = 3 * 60 * 1000;
export const GIF_FRAME_DELAY_MS = 700;
export const RADAR_STALE_AFTER_MS = 20 * 60 * 1000;
export const RADAR_GIF_CACHE_VERSION = 3;

export const STATES = ["nsw", "vic", "qld", "wa", "sa", "tas", "nt"] as const;

export const PRODUCT_LABELS: Record<string, string> = {
  "64 km": "64 km",
  "128 km": "128 km",
  "256 km": "256 km",
  "512 km composite": "512 km",
  "Doppler wind": "Doppler wind",
  "5 min rainfall": "5 min rainfall",
  "1 hour rainfall": "1 hour rainfall",
  "rainfall since 9am": "Rain since 9am",
  "24 hour rainfall": "24 hour rainfall",
};
