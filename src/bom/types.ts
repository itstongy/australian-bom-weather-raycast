export type RadarProduct = {
  id: string;
  site: string;
  state: string;
  label: string;
  loopUrl: string;
};

export type RadarFrame = {
  url: string;
  file: string;
  timestamp?: string;
};

export type RenderResult = {
  gifPath: string;
  frames: number;
  product: RadarProduct;
  freshness: "fresh" | "stale" | "unknown";
  latestFrameTime?: string;
  latestFrameAgeMinutes?: number;
  statusReport?: string;
};

export type RadarSite = {
  key: string;
  site: string;
  state: string;
  products: RadarProduct[];
};

export class RadarUnavailableError extends Error {
  readonly product: RadarProduct;
  readonly statusReport?: string;

  constructor(product: RadarProduct, message: string, statusReport?: string) {
    super(message);
    this.name = "RadarUnavailableError";
    this.product = product;
    this.statusReport = statusReport;
  }
}

export function isRadarProduct(value: unknown): value is RadarProduct {
  if (!value || typeof value !== "object") return false;
  const product = value as Record<string, unknown>;
  return (
    typeof product.id === "string" &&
    /^IDR[A-Z0-9]+$/.test(product.id) &&
    typeof product.site === "string" &&
    typeof product.state === "string" &&
    typeof product.label === "string" &&
    typeof product.loopUrl === "string" &&
    /^https:\/\//.test(product.loopUrl)
  );
}

export function isRadarFrame(value: unknown): value is RadarFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  return (
    typeof frame.url === "string" &&
    /^https?:\/\//.test(frame.url) &&
    typeof frame.file === "string" &&
    /^[A-Za-z0-9._-]+\.png$/.test(frame.file) &&
    (frame.timestamp === undefined ||
      (typeof frame.timestamp === "string" && /^\d{12}$/.test(frame.timestamp)))
  );
}
