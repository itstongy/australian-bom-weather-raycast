import { join } from "node:path";
import { BASE_URL, CATALOG_TTL_MS, PRODUCT_LABELS, STATES } from "./constants";
import { cacheDir, readFreshJson, readJsonFile, writeJsonFile } from "./cache";
import { httpGetText } from "./http";
import { decodeHtml } from "./text";
import { isRadarProduct, RadarProduct, RadarSite } from "./types";

function isRadarProductArray(value: unknown): value is RadarProduct[] {
  return Array.isArray(value) && value.every(isRadarProduct);
}

export async function discoverRadarProducts(): Promise<RadarProduct[]> {
  const cachePath = join(cacheDir(), "radar-products.json");
  const cached = readFreshJson(cachePath, CATALOG_TTL_MS, isRadarProductArray);
  if (cached) return cached;

  const stale = readJsonFile(cachePath, isRadarProductArray);
  const products: RadarProduct[] = [];

  try {
    for (const state of STATES) {
      const html = await httpGetText(
        `${BASE_URL}/australia/radar/${state}_radar_sites_table.shtml`,
      );
      let currentSite = "";
      const linkRegex =
        /<a\s+href="(?<href>[^"]+)"(?:\s+title="(?<title>[^"]+)")?[^>]*>(?<text>[^<]+)<\/a>/g;
      let match;

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
          state: state.toUpperCase(),
          label: PRODUCT_LABELS[text] ?? text,
          loopUrl: `${BASE_URL}${href}`,
        });
      }
    }
  } catch (error) {
    if (stale) return stale;
    throw error;
  }

  const discovered = dedupeProducts(products).sort((a, b) =>
    `${a.state} ${a.site} ${a.label}`.localeCompare(
      `${b.state} ${b.site} ${b.label}`,
    ),
  );
  writeJsonFile(cachePath, discovered);
  return discovered;
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
