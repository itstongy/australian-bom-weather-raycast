import { Detail, List } from "@raycast/api";
import { useEffect, useState } from "react";
import { ErrorDetail, RadarLoop } from "./radar";
import { loadReadyCatalog, ReadyCatalog } from "./radar-state";
import { configureRuntime } from "./runtime";

configureRuntime();

type State =
  | { status: "loading" }
  | { status: "ready"; catalog: ReadyCatalog }
  | { status: "error"; message: string };

export default function Command() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    loadReadyCatalog()
      .then((catalog) => setState({ status: "ready", catalog }))
      .catch((error) =>
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  }, []);

  if (state.status === "loading")
    return (
      <Detail isLoading markdown={"# Favorite Radar\n\nLoading favorite..."} />
    );
  if (state.status === "error")
    return <ErrorDetail title="Favorite Radar" message={state.message} />;

  const product =
    state.catalog.products.find(
      (item) => item.id === state.catalog.quickFavoriteId,
    ) ??
    state.catalog.favoriteIds
      .map((id) => state.catalog.products.find((item) => item.id === id))
      .find(Boolean);

  if (!product) {
    return (
      <List searchBarPlaceholder="No quick favorite set. Add one from Browse Radar Loops.">
        <List.EmptyView
          title="No Favorite Radar"
          description="Set a quick favorite from Browse Radar Loops."
        />
      </List>
    );
  }

  return <RadarLoop product={product} catalog={state.catalog} />;
}
