export const FRAME_OPTIONS = [4, 7, 10, 12] as const;
export const DEFAULT_FRAME_COUNT = 7;

export function sanitizeFavoriteIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map(normalizeRadarProductId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
}

export function normalizeRadarProductId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  return /^IDR[A-Z0-9]{3}$/.test(normalized) ? normalized : undefined;
}

export function normalizeFrameCount(value: unknown) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  return FRAME_OPTIONS.includes(parsed as (typeof FRAME_OPTIONS)[number])
    ? parsed
    : DEFAULT_FRAME_COUNT;
}
