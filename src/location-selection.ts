import { WeatherLocation } from "./weather";

const GEOHASH_PATTERN = /^[0-9bcdefghjkmnpqrstuvwxyz]{6}$/;

export function normalizeLocationGeohash(value: unknown) {
  if (typeof value !== "string") return undefined;
  const suffix = value.trim().toLowerCase().split("-").at(-1) ?? "";
  const geohash = suffix.slice(0, 6);
  return GEOHASH_PATTERN.test(geohash) ? geohash : undefined;
}

export function normalizeStoredLocation(
  value: unknown,
): WeatherLocation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const geohash = normalizeLocationGeohash(candidate.geohash);
  const name = normalizeRequiredString(candidate.name);
  if (!geohash || !name) return null;

  return {
    geohash,
    name,
    ...optionalString("state", candidate.state),
    ...optionalString("postcode", candidate.postcode),
    ...optionalString("id", candidate.id),
  };
}

export function sanitizeStoredLocations(value: unknown): WeatherLocation[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const locations: WeatherLocation[] = [];
  for (const item of value) {
    const location = normalizeStoredLocation(item);
    if (!location || seen.has(location.geohash)) continue;
    seen.add(location.geohash);
    locations.push(location);
  }
  return locations;
}

export function selectDefaultLocation(
  locations: WeatherLocation[],
  defaultGeohash?: string,
) {
  const normalizedDefault = normalizeLocationGeohash(defaultGeohash);
  return (
    locations.find((location) => location.geohash === normalizedDefault) ??
    locations[0] ??
    null
  );
}

function normalizeRequiredString(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function optionalString(key: "state" | "postcode" | "id", value: unknown) {
  const normalized = normalizeRequiredString(value);
  return normalized ? { [key]: normalized } : {};
}
