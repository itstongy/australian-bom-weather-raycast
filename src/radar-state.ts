import { LocalStorage } from "@raycast/api";
import {
  discoverRadarProducts,
  groupRadarSites,
  RadarProduct,
  RadarSite,
} from "./bom";
import {
  normalizeFrameCount,
  normalizeRadarProductId,
  sanitizeFavoriteIds,
} from "./radar-selection";

export { FRAME_OPTIONS } from "./radar-selection";

const LAST_PRODUCT_KEY = "last-product-id";
const LAST_FRAME_COUNT_KEY = "last-frame-count";
const FAVORITES_KEY = "favorite-product-ids";
const QUICK_FAVORITE_KEY = "quick-favorite-product-id";

export type CatalogState =
  { status: "loading" } | ReadyCatalog | { status: "error"; message: string };

export type ReadyCatalog = {
  status: "ready";
  products: RadarProduct[];
  sites: RadarSite[];
  favoriteIds: string[];
  quickFavoriteId?: string;
  lastProductId?: string;
  frameCount: number;
};

export async function loadReadyCatalog(
  signal?: AbortSignal,
): Promise<ReadyCatalog> {
  const [
    products,
    favoriteIds,
    quickFavoriteId,
    lastProductId,
    storedFrameCount,
  ] = await Promise.all([
    discoverRadarProducts({ signal }),
    LocalStorage.getItem<string>(FAVORITES_KEY),
    LocalStorage.getItem<string>(QUICK_FAVORITE_KEY),
    LocalStorage.getItem<string>(LAST_PRODUCT_KEY),
    LocalStorage.getItem<string>(LAST_FRAME_COUNT_KEY),
  ]);

  const repairedFavoriteIds = sanitizeFavoriteIds(parseJson(favoriteIds));
  const repairedQuickFavoriteId = normalizeRadarProductId(quickFavoriteId);
  const repairedLastProductId = normalizeRadarProductId(lastProductId);
  const frameCount = normalizeFrameCount(storedFrameCount);

  await Promise.all([
    repairJson(FAVORITES_KEY, favoriteIds, repairedFavoriteIds),
    repairOptionalProductId(
      QUICK_FAVORITE_KEY,
      quickFavoriteId,
      repairedQuickFavoriteId,
    ),
    repairOptionalProductId(
      LAST_PRODUCT_KEY,
      lastProductId,
      repairedLastProductId,
    ),
    storedFrameCount === String(frameCount)
      ? Promise.resolve()
      : LocalStorage.setItem(LAST_FRAME_COUNT_KEY, String(frameCount)),
  ]);

  return {
    status: "ready",
    products,
    sites: groupRadarSites(products),
    favoriteIds: repairedFavoriteIds,
    quickFavoriteId: repairedQuickFavoriteId,
    lastProductId: repairedLastProductId,
    frameCount,
  };
}

export async function setFavorite(productId: string, enabled: boolean) {
  const normalizedId = requireRadarProductId(productId);
  const favorites = sanitizeFavoriteIds(
    parseJson(await LocalStorage.getItem<string>(FAVORITES_KEY)),
  );
  const next = enabled
    ? [...new Set([...favorites, normalizedId])]
    : favorites.filter((id) => id !== normalizedId);
  await LocalStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
  if (!enabled) {
    const quickFavorite = normalizeRadarProductId(
      await LocalStorage.getItem<string>(QUICK_FAVORITE_KEY),
    );
    if (quickFavorite === normalizedId)
      await LocalStorage.removeItem(QUICK_FAVORITE_KEY);
  }
  return next;
}

export async function setQuickFavorite(productId: string) {
  const normalizedId = requireRadarProductId(productId);
  await setFavorite(normalizedId, true);
  await LocalStorage.setItem(QUICK_FAVORITE_KEY, normalizedId);
  return normalizedId;
}

export function clearQuickFavorite() {
  return LocalStorage.removeItem(QUICK_FAVORITE_KEY);
}

export async function rememberRadarSelection(
  productId: string,
  frameCount: number,
) {
  const normalizedId = requireRadarProductId(productId);
  const normalizedFrameCount = normalizeFrameCount(frameCount);
  await LocalStorage.setItem(LAST_PRODUCT_KEY, normalizedId);
  await LocalStorage.setItem(
    LAST_FRAME_COUNT_KEY,
    String(normalizedFrameCount),
  );
}

function requireRadarProductId(value: unknown) {
  const normalized = normalizeRadarProductId(value);
  if (!normalized) throw new Error("Invalid BOM radar product ID");
  return normalized;
}

function parseJson(raw?: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

async function repairJson(
  key: string,
  raw: string | undefined,
  value: unknown,
) {
  const repaired = JSON.stringify(value);
  if (raw !== repaired) await LocalStorage.setItem(key, repaired);
}

async function repairOptionalProductId(
  key: string,
  raw: string | undefined,
  value?: string,
) {
  if (value) {
    if (raw !== value) await LocalStorage.setItem(key, value);
  } else if (raw !== undefined) {
    await LocalStorage.removeItem(key);
  }
}
