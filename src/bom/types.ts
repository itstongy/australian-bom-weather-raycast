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
  freshness: "fresh" | "stale";
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
    typeof product.site === "string" &&
    typeof product.state === "string" &&
    typeof product.label === "string" &&
    typeof product.loopUrl === "string"
  );
}

export function isRadarFrame(value: unknown): value is RadarFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  return (
    typeof frame.url === "string" &&
    typeof frame.file === "string" &&
    (frame.timestamp === undefined || typeof frame.timestamp === "string")
  );
}
