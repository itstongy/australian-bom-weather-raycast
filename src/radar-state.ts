import { LocalStorage } from "@raycast/api";
import {
  discoverRadarProducts,
  groupRadarSites,
  RadarProduct,
  RadarSite,
} from "./bom";

export const FRAME_OPTIONS = [4, 7, 10, 12];

const LAST_PRODUCT_KEY = "last-product-id";
const LAST_FRAME_COUNT_KEY = "last-frame-count";
const FAVORITES_KEY = "favorite-product-ids";
const QUICK_FAVORITE_KEY = "quick-favorite-product-id";

export type CatalogState =
  | { status: "loading" }
  | ReadyCatalog
  | { status: "error"; message: string };

export type ReadyCatalog = {
  status: "ready";
  products: RadarProduct[];
  sites: RadarSite[];
  favoriteIds: string[];
  quickFavoriteId?: string;
  lastProductId?: string;
  frameCount: number;
};

export async function loadReadyCatalog(): Promise<ReadyCatalog> {
  const [
    products,
    favoriteIds,
    quickFavoriteId,
    lastProductId,
    storedFrameCount,
  ] = await Promise.all([
    discoverRadarProducts(),
    readJson<string[]>(FAVORITES_KEY, []),
    LocalStorage.getItem<string>(QUICK_FAVORITE_KEY),
    LocalStorage.getItem<string>(LAST_PRODUCT_KEY),
    LocalStorage.getItem<string>(LAST_FRAME_COUNT_KEY),
  ]);

  return {
    status: "ready",
    products,
    sites: groupRadarSites(products),
    favoriteIds,
    quickFavoriteId,
    lastProductId,
    frameCount: clampFrameCount(Number.parseInt(storedFrameCount ?? "", 10)),
  };
}

export async function setFavorite(productId: string, enabled: boolean) {
  const favorites = await readJson<string[]>(FAVORITES_KEY, []);
  const next = enabled
    ? [...new Set([...favorites, productId])]
    : favorites.filter((id) => id !== productId);
  await LocalStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
}

export async function setQuickFavorite(productId: string) {
  await LocalStorage.setItem(QUICK_FAVORITE_KEY, productId);
  await setFavorite(productId, true);
}

export function clearQuickFavorite() {
  return LocalStorage.removeItem(QUICK_FAVORITE_KEY);
}

export async function rememberRadarSelection(
  productId: string,
  frameCount: number,
) {
  await LocalStorage.setItem(LAST_PRODUCT_KEY, productId);
  await LocalStorage.setItem(LAST_FRAME_COUNT_KEY, String(frameCount));
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await LocalStorage.getItem<string>(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function clampFrameCount(value: number) {
  if (!Number.isFinite(value)) return 7;
  return Math.max(1, Math.min(value, 12));
}
