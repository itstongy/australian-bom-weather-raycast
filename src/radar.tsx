import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
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

export default function Command() {
  return <RadarBrowser />;
}

export function RadarBrowser() {
  const [state, setState] = useState<CatalogState>({ status: "loading" });

  useEffect(() => {
    async function loadCatalog() {
      try {
        setState(await loadReadyCatalog());
      } catch (error) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    loadCatalog();
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
            />
          ))}
        </List.Section>
      )}
      <List.Section title="Radar Sites">
        {orderedSites
          .filter((site) => !favoriteSiteKeys.has(site.key))
          .map((site) => (
            <SiteItem key={site.key} site={site} catalog={state} />
          ))}
      </List.Section>
    </List>
  );
}

function SiteItem({
  site,
  catalog,
}: {
  site: RadarSite;
  catalog: ReadyCatalog;
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
            target={<ProductList site={site} catalog={catalog} />}
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
}: {
  site: RadarSite;
  catalog: ReadyCatalog;
}) {
  const favoriteProducts = site.products.filter((product) =>
    catalog.favoriteIds.includes(product.id),
  );
  const otherProducts = site.products.filter(
    (product) => !catalog.favoriteIds.includes(product.id),
  );

  return (
    <List
      navigationTitle={site.site}
      searchBarPlaceholder={`Select ${site.site} product`}
    >
      {favoriteProducts.length > 0 && (
        <List.Section title="Favorites">
          {favoriteProducts.map((product) => (
            <ProductItem key={product.id} product={product} catalog={catalog} />
          ))}
        </List.Section>
      )}
      <List.Section title="Products">
        {otherProducts.map((product) => (
          <ProductItem key={product.id} product={product} catalog={catalog} />
        ))}
      </List.Section>
    </List>
  );
}

function ProductItem({
  product,
  catalog,
}: {
  product: RadarProduct;
  catalog: ReadyCatalog;
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
      actions={<ProductActions product={product} catalog={catalog} />}
    />
  );
}

function ProductActions({
  product,
  catalog,
}: {
  product: RadarProduct;
  catalog: ReadyCatalog;
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
          await setFavorite(product.id, !isFavorite);
          await showToast({
            style: Toast.Style.Success,
            title: isFavorite ? "Removed favorite" : "Added favorite",
          });
        }}
      />
      <Action
        title={
          isQuickFavorite ? "Clear Quick Favorite" : "Set as Quick Favorite"
        }
        icon={Icon.Bolt}
        onAction={async () => {
          if (isQuickFavorite) {
            await clearQuickFavorite();
            await showToast({
              style: Toast.Style.Success,
              title: "Cleared quick favorite",
            });
          } else {
            await setQuickFavorite(product.id);
            await showToast({
              style: Toast.Style.Success,
              title: "Set quick favorite",
              message: product.id,
            });
          }
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
    let cancelled = false;

    async function renderLoop() {
      try {
        await showToast({
          style: Toast.Style.Animated,
          title: "Rendering radar loop",
          message: product.id,
        });
        await rememberRadarSelection(product.id, catalog.frameCount);
        const result = await renderRadarLoop(product, catalog.frameCount);
        if (!cancelled) {
          setState({ status: "ready", result });
          await showToast({
            style: Toast.Style.Success,
            title: "Radar loop ready",
            message: product.id,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!cancelled) {
          setState({
            status: "error",
            message,
            statusReport:
              error instanceof RadarUnavailableError
                ? error.statusReport
                : undefined,
          });
          await showToast({
            style: Toast.Style.Failure,
            title: "Failed to render radar",
            message,
          });
        }
      }
    }

    renderLoop();

    return () => {
      cancelled = true;
    };
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
  const staleNote =
    result.freshness === "stale"
      ? `\n\n> Radar frames look stale. Latest frame is ${result.latestFrameAgeMinutes} minutes old. The radar may be offline or delayed.`
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
    staleNote,
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
            text={result.freshness === "stale" ? "Stale" : "Fresh"}
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
