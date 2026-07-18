import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { attributionMarkdown } from "./attribution";
import {
  RadarProduct,
  RadarSite,
  RadarUnavailableError,
  renderRadarLoop,
  RenderResult,
  siblingProducts,
  siteKey,
} from "./bom";
import { radarImageMarkdown } from "./radar-markdown";
import {
  LifecycleToastKind,
  startRadarRenderLifecycle,
} from "./radar-render-lifecycle";
import { startRadarCatalogLoadLifecycle } from "./radar-catalog-lifecycle";
import {
  CatalogState,
  clearQuickFavorite,
  FRAME_OPTIONS,
  loadReadyCatalog,
  ReadyCatalog,
  rememberRadarSelection,
  setFavorite,
  setQuickFavorite,
} from "./radar-state";
import { configureRuntime } from "./runtime";

configureRuntime();

const DISPLAY_SIZE = 430;

type LoopState =
  | { status: "loading" }
  | { status: "ready"; result: RenderResult }
  | { status: "error"; message: string; statusReport?: string };

type CatalogChange = (updater: (catalog: ReadyCatalog) => ReadyCatalog) => void;

export default function Command() {
  return <RadarBrowser />;
}

export function RadarBrowser() {
  const [state, setState] = useState<CatalogState>({ status: "loading" });
  const updateCatalog = useCallback<CatalogChange>((updater) => {
    setState((current) =>
      current.status === "ready" ? updater(current) : current,
    );
  }, []);

  useEffect(() => {
    const lifecycle = startRadarCatalogLoadLifecycle({
      load: loadReadyCatalog,
      onReady: setState,
      onError: (error) =>
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
    });
    return lifecycle.cancel;
  }, []);

  if (state.status === "loading")
    return <List isLoading searchBarPlaceholder="Loading BOM radar sites..." />;
  if (state.status === "error")
    return <ErrorDetail title="BOM Radar" message={state.message} />;

  const favoriteProducts = state.favoriteIds
    .map((id) => state.products.find((product) => product.id === id))
    .filter((product): product is RadarProduct => Boolean(product));
  const favoriteSiteKeys = new Set(favoriteProducts.map(siteKey));
  const favoriteSites = state.sites.filter((site) =>
    favoriteSiteKeys.has(site.key),
  );
  const remainingSites = state.sites.filter(
    (site) => !favoriteSiteKeys.has(site.key),
  );
  const orderedSites = sortSitesByLast(
    [...favoriteSites, ...remainingSites],
    state.products,
    state.lastProductId,
  );

  return (
    <List searchBarPlaceholder="Search radar sites, states, and towns">
      {favoriteSites.length > 0 && (
        <List.Section title="Favorites">
          {favoriteSites.map((site) => (
            <SiteItem
              key={`favorite-${site.key}`}
              site={site}
              catalog={state}
              onCatalogChange={updateCatalog}
            />
          ))}
        </List.Section>
      )}
      <List.Section title="Radar Sites">
        {orderedSites
          .filter((site) => !favoriteSiteKeys.has(site.key))
          .map((site) => (
            <SiteItem
              key={site.key}
              site={site}
              catalog={state}
              onCatalogChange={updateCatalog}
            />
          ))}
      </List.Section>
    </List>
  );
}

function SiteItem({
  site,
  catalog,
  onCatalogChange,
}: {
  site: RadarSite;
  catalog: ReadyCatalog;
  onCatalogChange: CatalogChange;
}) {
  const favoriteCount = site.products.filter((product) =>
    catalog.favoriteIds.includes(product.id),
  ).length;

  return (
    <List.Item
      title={site.site}
      subtitle={`${site.products.length} products`}
      accessories={[
        { text: site.state },
        favoriteCount ? { icon: Icon.Star, text: String(favoriteCount) } : {},
      ]}
      actions={
        <ActionPanel>
          <Action.Push
            title="Select Product"
            icon={Icon.List}
            target={
              <ProductList
                site={site}
                catalog={catalog}
                onCatalogChange={onCatalogChange}
              />
            }
          />
          {site.products[0] && (
            <Action.Push
              title="Show Default Product"
              icon={Icon.Eye}
              target={
                <RadarLoop
                  product={preferredProduct(site.products, catalog)}
                  catalog={catalog}
                />
              }
            />
          )}
        </ActionPanel>
      }
    />
  );
}

function ProductList({
  site,
  catalog,
  onCatalogChange,
}: {
  site: RadarSite;
  catalog: ReadyCatalog;
  onCatalogChange: CatalogChange;
}) {
  const [activeCatalog, setActiveCatalog] = useState(catalog);
  const updateActiveCatalog = useCallback<CatalogChange>(
    (updater) => {
      setActiveCatalog(updater);
      onCatalogChange(updater);
    },
    [onCatalogChange],
  );
  const favoriteProducts = site.products.filter((product) =>
    activeCatalog.favoriteIds.includes(product.id),
  );
  const otherProducts = site.products.filter(
    (product) => !activeCatalog.favoriteIds.includes(product.id),
  );

  return (
    <List
      navigationTitle={site.site}
      searchBarPlaceholder={`Select ${site.site} product`}
    >
      {favoriteProducts.length > 0 && (
        <List.Section title="Favorites">
          {favoriteProducts.map((product) => (
            <ProductItem
              key={product.id}
              product={product}
              catalog={activeCatalog}
              onCatalogChange={updateActiveCatalog}
            />
          ))}
        </List.Section>
      )}
      <List.Section title="Products">
        {otherProducts.map((product) => (
          <ProductItem
            key={product.id}
            product={product}
            catalog={activeCatalog}
            onCatalogChange={updateActiveCatalog}
          />
        ))}
      </List.Section>
    </List>
  );
}

function ProductItem({
  product,
  catalog,
  onCatalogChange,
}: {
  product: RadarProduct;
  catalog: ReadyCatalog;
  onCatalogChange: CatalogChange;
}) {
  const isFavorite = catalog.favoriteIds.includes(product.id);
  const isQuickFavorite = catalog.quickFavoriteId === product.id;

  return (
    <List.Item
      title={product.label}
      subtitle={product.id}
      accessories={[
        isQuickFavorite ? { icon: Icon.Bolt, text: "Quick" } : {},
        isFavorite ? { icon: Icon.Star } : {},
      ]}
      actions={
        <ProductActions
          product={product}
          catalog={catalog}
          onCatalogChange={onCatalogChange}
        />
      }
    />
  );
}

function ProductActions({
  product,
  catalog,
  onCatalogChange,
}: {
  product: RadarProduct;
  catalog: ReadyCatalog;
  onCatalogChange: CatalogChange;
}) {
  const isFavorite = catalog.favoriteIds.includes(product.id);
  const isQuickFavorite = catalog.quickFavoriteId === product.id;

  return (
    <ActionPanel>
      <Action.Push
        title="Show Radar Loop"
        icon={Icon.Eye}
        target={<RadarLoop product={product} catalog={catalog} />}
      />
      <Action
        title={isFavorite ? "Remove Favorite" : "Add Favorite"}
        icon={isFavorite ? Icon.StarDisabled : Icon.Star}
        onAction={async () => {
          await runRadarAction(
            isFavorite ? "Remove favorite" : "Add favorite",
            async () => {
              await setFavorite(product.id, !isFavorite);
              onCatalogChange((current) => ({
                ...current,
                favoriteIds: isFavorite
                  ? current.favoriteIds.filter((id) => id !== product.id)
                  : [...new Set([...current.favoriteIds, product.id])],
                quickFavoriteId:
                  isFavorite && current.quickFavoriteId === product.id
                    ? undefined
                    : current.quickFavoriteId,
              }));
              await showToast({
                style: Toast.Style.Success,
                title: isFavorite ? "Removed favorite" : "Added favorite",
              });
            },
          );
        }}
      />
      <Action
        title={
          isQuickFavorite ? "Clear Quick Favorite" : "Set as Quick Favorite"
        }
        icon={Icon.Bolt}
        onAction={async () => {
          await runRadarAction("Update quick favorite", async () => {
            if (isQuickFavorite) {
              await clearQuickFavorite();
              onCatalogChange((current) => ({
                ...current,
                quickFavoriteId: undefined,
              }));
              await showToast({
                style: Toast.Style.Success,
                title: "Cleared quick favorite",
              });
            } else {
              await setQuickFavorite(product.id);
              onCatalogChange((current) => ({
                ...current,
                quickFavoriteId: product.id,
                favoriteIds: [...new Set([...current.favoriteIds, product.id])],
              }));
              await showToast({
                style: Toast.Style.Success,
                title: "Set quick favorite",
                message: product.id,
              });
            }
          });
        }}
      />
      <FrameCountActions product={product} catalog={catalog} />
      <Action.OpenInBrowser title="Open BOM Loop Page" url={product.loopUrl} />
      <Action.CopyToClipboard title="Copy Product ID" content={product.id} />
    </ActionPanel>
  );
}

export function RadarLoop({
  product,
  catalog,
}: {
  product: RadarProduct;
  catalog: ReadyCatalog;
}) {
  const [state, setState] = useState<LoopState>({ status: "loading" });
  const siblings = useMemo(
    () => siblingProducts(catalog.products, product),
    [product, catalog.products],
  );

  useEffect(() => {
    const lifecycle = startRadarRenderLifecycle({
      productId: product.id,
      beforeRender: () =>
        rememberRadarSelection(product.id, catalog.frameCount),
      render: (signal) =>
        renderRadarLoop(product, catalog.frameCount, { signal }),
      showToast: ({ kind, title, message }) =>
        showToast({ style: toastStyle(kind), title, message }),
      onReady: (result) => setState({ status: "ready", result }),
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        setState({
          status: "error",
          message,
          statusReport:
            error instanceof RadarUnavailableError
              ? error.statusReport
              : undefined,
        });
      },
    });
    return lifecycle.cancel;
  }, [catalog.frameCount, product]);

  if (state.status === "loading") {
    return (
      <Detail
        isLoading
        markdown={`# ${product.site}\n\nRendering ${product.label} (${product.id})...`}
      />
    );
  }
  if (state.status === "error") {
    const report = state.statusReport
      ? `\n\n## BoM Status Report\n\n${state.statusReport}`
      : "";
    return (
      <Detail
        markdown={`# ${product.site}\n\nCould not render ${product.label} (${product.id}).\n\n\`\`\`text\n${state.message}\n\`\`\`${report}`}
        actions={
          <ActionPanel>
            <Action.OpenInBrowser
              title="Open BOM Loop Page"
              url={product.loopUrl}
            />
          </ActionPanel>
        }
      />
    );
  }

  const { result } = state;
  const freshnessNote =
    result.freshness === "stale"
      ? `\n\n> Radar frames look stale. Latest frame is ${result.latestFrameAgeMinutes} minutes old. The radar may be offline or delayed.`
      : result.freshness === "unknown"
        ? "\n\n> Radar frame freshness is unknown because the latest timestamp was unavailable."
        : "";
  const statusReport = result.statusReport
    ? `\n\n## BoM Status Report\n\n${result.statusReport}`
    : "";
  const markdown = [
    `# ${result.product.site}`,
    "",
    radarImageMarkdown({
      alt: `${result.product.id} radar loop`,
      path: result.gifPath,
      size: DISPLAY_SIZE,
    }),
    "",
    `**${result.product.label}** · ${result.product.state} · ${result.product.id} · ${result.frames} frames`,
    freshnessNote,
    statusReport,
    "",
    attributionMarkdown(),
  ].join("\n");

  return (
    <Detail
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Site" text={result.product.site} />
          <Detail.Metadata.Label title="Product" text={result.product.label} />
          <Detail.Metadata.Label title="State" text={result.product.state} />
          <Detail.Metadata.Label title="ID" text={result.product.id} />
          <Detail.Metadata.Label title="Frames" text={String(result.frames)} />
          <Detail.Metadata.Label
            title="Status"
            text={formatFreshness(result.freshness)}
          />
          {result.latestFrameAgeMinutes !== undefined && (
            <Detail.Metadata.Label
              title="Latest Frame"
              text={`${result.latestFrameAgeMinutes} min ago`}
            />
          )}
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action.Open title="Open GIF" target={result.gifPath} />
          <Action.OpenWith
            title="Open GIF in Application"
            path={result.gifPath}
          />
          <ActionPanel.Submenu
            title="Switch Product…"
            icon={Icon.ArrowClockwise}
          >
            {siblings.map((item) => (
              <Action.Push
                key={item.id}
                title={`${item.label} (${item.id})`}
                target={<RadarLoop product={item} catalog={catalog} />}
              />
            ))}
          </ActionPanel.Submenu>
          <FrameCountActions product={product} catalog={catalog} />
          <Action.OpenInBrowser
            title="Open BOM Loop Page"
            url={result.product.loopUrl}
          />
          <Action.CopyToClipboard
            title="Copy GIF Path"
            content={result.gifPath}
          />
          <Action.CopyToClipboard
            title="Copy Product ID"
            content={result.product.id}
          />
        </ActionPanel>
      }
    />
  );
}

function FrameCountActions({
  product,
  catalog,
}: {
  product: RadarProduct;
  catalog: ReadyCatalog;
}) {
  return (
    <ActionPanel.Submenu title="Frame Count…" icon={Icon.Clock}>
      {FRAME_OPTIONS.map((count) => (
        <Action.Push
          key={count}
          title={`${count} Frames${count === catalog.frameCount ? " (Current)" : ""}`}
          target={
            <RadarLoop
              product={product}
              catalog={{ ...catalog, frameCount: count }}
            />
          }
        />
      ))}
    </ActionPanel.Submenu>
  );
}

export function ErrorDetail({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return <Detail markdown={`# ${title}\n\n\`\`\`text\n${message}\n\`\`\``} />;
}

function sortSitesByLast(
  sites: RadarSite[],
  products: RadarProduct[],
  lastProductId?: string,
) {
  if (!lastProductId) return sites;
  const last = products.find((product) => product.id === lastProductId);
  if (!last) return sites;
  const lastKey = siteKey(last);
  return [...sites].sort((a, b) => {
    if (a.key === lastKey) return -1;
    if (b.key === lastKey) return 1;
    return 0;
  });
}

function preferredProduct(products: RadarProduct[], catalog: ReadyCatalog) {
  return (
    products.find((product) => product.id === catalog.quickFavoriteId) ??
    products.find((product) => product.id === catalog.lastProductId) ??
    products.find((product) => product.label === "128 km") ??
    products[0]
  );
}

async function runRadarAction(title: string, action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: `${title} failed`,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function formatFreshness(freshness: RenderResult["freshness"]) {
  if (freshness === "fresh") return "Fresh";
  if (freshness === "stale") return "Stale";
  return "Unknown";
}

function toastStyle(kind: LifecycleToastKind) {
  if (kind === "animated") return Toast.Style.Animated;
  if (kind === "success") return Toast.Style.Success;
  return Toast.Style.Failure;
}
