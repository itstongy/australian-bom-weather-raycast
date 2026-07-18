export type RadarCatalogLoadOutcome = "ready" | "error" | "cancelled";

type RadarCatalogLoadDependencies<Catalog> = {
  load(signal: AbortSignal): Promise<Catalog>;
  onReady(catalog: Catalog): void;
  onError(error: unknown): void;
};

export function startRadarCatalogLoadLifecycle<Catalog>({
  load,
  onReady,
  onError,
}: RadarCatalogLoadDependencies<Catalog>) {
  const controller = new AbortController();
  let active = true;

  const done: Promise<RadarCatalogLoadOutcome> = Promise.resolve()
    .then(() => load(controller.signal))
    .then((catalog) => {
      if (!active) return "cancelled";
      onReady(catalog);
      return "ready";
    })
    .catch((error: unknown) => {
      if (!active || isAbortError(error)) return "cancelled";
      onError(error);
      return "error";
    });

  function cancel() {
    if (!active) return;
    active = false;
    controller.abort();
  }

  return { cancel, done, signal: controller.signal };
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
