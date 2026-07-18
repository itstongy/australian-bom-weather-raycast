import { join } from "node:path";
import {
  BASE_URL,
  CATALOG_TTL_MS,
  PRODUCT_LABELS,
  RADAR_GIF_CACHE_VERSION,
  STATES,
} from "./constants";
import {
  cacheDir,
  maybePruneRadarCache,
  readFreshJson,
  readJsonFile,
  writeJsonFile,
} from "./cache";
import { HttpGetOptions, httpGetText } from "./http";
import { decodeHtml } from "./text";
import { isRadarProduct, RadarProduct, RadarSite } from "./types";

const CATALOG_CONCURRENCY = 3;

type CatalogDiscoveryTask = {
  promise: Promise<RadarProduct[]>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
};

let pendingDiscovery: CatalogDiscoveryTask | null = null;

export type RadarCatalogOptions = HttpGetOptions & {
  getText?: typeof httpGetText;
};

function isRadarProductArray(value: unknown): value is RadarProduct[] {
  return Array.isArray(value) && value.every(isRadarProduct);
}

export async function discoverRadarProducts(
  options: RadarCatalogOptions = {},
): Promise<RadarProduct[]> {
  maybePruneRadarCache(RADAR_GIF_CACHE_VERSION);
  options.signal?.throwIfAborted();
  let task = pendingDiscovery;
  if (!task) {
    const controller = new AbortController();
    task = {
      promise: Promise.resolve(null as never),
      controller,
      consumers: 0,
      settled: false,
    };
    const currentTask = task;
    currentTask.promise = discover({
      ...options,
      signal: controller.signal,
    }).finally(() => {
      currentTask.settled = true;
      if (pendingDiscovery === currentTask) pendingDiscovery = null;
    });
    pendingDiscovery = currentTask;
  }
  return subscribeToDiscovery(task, options.signal);
}

function subscribeToDiscovery(
  task: CatalogDiscoveryTask,
  signal?: AbortSignal,
) {
  task.consumers += 1;
  return new Promise<RadarProduct[]>((resolve, reject) => {
    let finished = false;
    const finish = (callback: () => void) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      task.consumers -= 1;
      if (task.consumers === 0 && !task.settled) {
        if (pendingDiscovery === task) pendingDiscovery = null;
        task.controller.abort();
      }
      callback();
    };
    const onAbort = () =>
      finish(() => {
        const error = new Error("Radar catalogue discovery aborted");
        error.name = "AbortError";
        reject(error);
      });

    task.promise.then(
      (products) => finish(() => resolve(products)),
      (error) => finish(() => reject(error)),
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function discover(options: RadarCatalogOptions) {
  options.signal?.throwIfAborted();
  const cachePath = join(cacheDir(), "radar-products.json");
  const cached = readFreshJson(cachePath, CATALOG_TTL_MS, isRadarProductArray);
  if (cached) return cached;

  const stale = readJsonFile(cachePath, isRadarProductArray);
  let byState: RadarProduct[][];
  try {
    byState = await mapWithConcurrency(
      [...STATES],
      CATALOG_CONCURRENCY,
      async (state) => {
        const html = await (options.getText ?? httpGetText)(
          `${BASE_URL}/australia/radar/${state}_radar_sites_table.shtml`,
          options,
        );
        return parseRadarProductsHtml(html, state.toUpperCase());
      },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (stale) return stale;
    throw error;
  }

  const discovered = dedupeProducts(byState.flat()).sort((a, b) =>
    `${a.state} ${a.site} ${a.label}`.localeCompare(
      `${b.state} ${b.site} ${b.label}`,
    ),
  );
  writeJsonFile(cachePath, discovered);
  return discovered;
}

export function parseRadarProductsHtml(html: string, state: string) {
  const products: RadarProduct[] = [];
  let currentSite = "";
  const linkRegex =
    /<a\s+href="(?<href>[^"]+)"(?:\s+title="(?<title>[^"]+)")?[^>]*>(?<text>[^<]+)<\/a>/g;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match.groups?.href ?? "";
    const title = decodeHtml(match.groups?.title ?? "");
    const text = decodeHtml(match.groups?.text ?? "").trim();
    const siteMatch = title.match(/^(.+?) site information\./);

    if (siteMatch) {
      currentSite = siteMatch[1];
      continue;
    }

    const productMatch = href.match(
      /\/products\/(?<id>IDR[A-Z0-9]+)\.loop\.shtml$/,
    );
    if (!productMatch || !currentSite) continue;

    products.push({
      id: productMatch.groups?.id ?? "",
      site: currentSite,
      state,
      label: PRODUCT_LABELS[text] ?? text,
      loopUrl: `${BASE_URL}${href}`,
    });
  }

  return products;
}

export function siblingProducts(
  products: RadarProduct[],
  product: RadarProduct,
) {
  return products.filter(
    (item) => item.site === product.site && item.state === product.state,
  );
}

export function groupRadarSites(products: RadarProduct[]): RadarSite[] {
  const sites = new Map<string, RadarSite>();

  for (const product of products) {
    const key = siteKey(product);
    const existing = sites.get(key);
    if (existing) {
      existing.products.push(product);
    } else {
      sites.set(key, {
        key,
        site: product.site,
        state: product.state,
        products: [product],
      });
    }
  }

  return [...sites.values()]
    .map((site) => ({
      ...site,
      products: site.products.sort((a, b) =>
        productSortValue(a).localeCompare(productSortValue(b)),
      ),
    }))
    .sort((a, b) =>
      `${a.state} ${a.site}`.localeCompare(`${b.state} ${b.site}`),
    );
}

export function siteKey(product: Pick<RadarProduct, "state" | "site">) {
  return `${product.state}:${product.site}`;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () =>
      worker(),
    ),
  );
  return results;
}

function dedupeProducts(products: RadarProduct[]) {
  const seen = new Set<string>();
  return products.filter((product) => {
    if (!product.id || seen.has(product.id)) return false;
    seen.add(product.id);
    return true;
  });
}

function productSortValue(product: RadarProduct) {
  const order = [
    "64 km",
    "128 km",
    "256 km",
    "512 km",
    "Doppler wind",
    "5 min rainfall",
    "1 hour rainfall",
    "Rain since 9am",
    "24 hour rainfall",
  ];
  const index = order.indexOf(product.label);
  return `${index === -1 ? 99 : index}`.padStart(2, "0") + product.label;
}
