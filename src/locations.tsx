import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { attributionMarkdown } from "./attribution";
import { createLocationSearchLifecycle } from "./location-search-lifecycle";
import {
  getLocationState,
  removeLocation,
  saveLocation,
  setDefaultLocation,
} from "./location-store";
import { configureRuntime } from "./runtime";
import {
  LocationSearchResult,
  searchLocations,
  WeatherLocation,
} from "./weather";

configureRuntime();

type State = {
  saved: WeatherLocation[];
  results: LocationSearchResult[];
  isLoadingSaved: boolean;
  isLoadingSearch: boolean;
  defaultGeohash?: string;
  searchError?: string;
};

type LocationChange = (change: {
  saved?: WeatherLocation[];
  defaultGeohash?: string | null;
}) => void;

export default function Command() {
  const [state, setState] = useState<State>({
    saved: [],
    results: [],
    isLoadingSaved: true,
    isLoadingSearch: false,
  });
  const [query, setQuery] = useState("");

  useEffect(() => {
    let active = true;
    getLocationState()
      .then(({ saved, defaultGeohash }) => {
        if (!active) return;
        setState((current) => ({
          ...current,
          saved,
          defaultGeohash,
          isLoadingSaved: false,
        }));
      })
      .catch(async (error) => {
        if (!active) return;
        setState((current) => ({
          ...current,
          saved: [],
          isLoadingSaved: false,
        }));
        await showToast({
          style: Toast.Style.Failure,
          title: "Could not load saved locations",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const lifecycle = createLocationSearchLifecycle({
      search: searchLocations,
      update: (searchState) =>
        setState((current) => ({ ...current, ...searchState })),
      reportError: (searchedQuery, message) =>
        showToast({
          style: Toast.Style.Failure,
          title: `Could not search for “${searchedQuery}”`,
          message,
        }).then(() => undefined),
    });
    lifecycle.replace(query);
    return lifecycle.dispose;
  }, [query]);

  return (
    <List
      isLoading={state.isLoadingSaved || state.isLoadingSearch}
      searchText={query}
      onSearchTextChange={setQuery}
      throttle
      searchBarPlaceholder="Search suburb or postcode"
    >
      {state.saved.length > 0 && (
        <List.Section title="Saved Locations">
          {state.saved.map((location) => (
            <List.Item
              key={location.geohash}
              title={location.name}
              subtitle={[location.state, location.postcode]
                .filter(Boolean)
                .join(" ")}
              icon={
                state.defaultGeohash === location.geohash ? Icon.Star : Icon.Pin
              }
              accessories={[
                ...(state.defaultGeohash === location.geohash
                  ? [{ text: "Default", icon: Icon.Star }]
                  : []),
                { text: location.geohash },
              ]}
              actions={
                <SavedLocationActions
                  location={location}
                  isDefault={state.defaultGeohash === location.geohash}
                  onChange={(change) =>
                    setState((current) => ({
                      ...current,
                      ...(change.saved ? { saved: change.saved } : {}),
                      ...(change.defaultGeohash !== undefined
                        ? {
                            defaultGeohash: change.defaultGeohash ?? undefined,
                          }
                        : {}),
                    }))
                  }
                />
              }
            />
          ))}
        </List.Section>
      )}

      <List.Section
        title={
          query.trim().length < 2
            ? "Search Results"
            : `Search Results for "${query}"`
        }
      >
        {state.results.map((result) => (
          <List.Item
            key={result.id}
            title={result.name}
            subtitle={`${result.state} ${result.postcode}`}
            accessories={[{ text: result.geohash.slice(0, 6) }]}
            actions={
              <SearchResultActions
                result={result}
                onChange={(change) =>
                  setState((current) => ({
                    ...current,
                    ...(change.saved ? { saved: change.saved } : {}),
                    ...(change.defaultGeohash !== undefined
                      ? {
                          defaultGeohash: change.defaultGeohash ?? undefined,
                        }
                      : {}),
                  }))
                }
              />
            }
          />
        ))}
      </List.Section>
      {state.searchError && (
        <List.EmptyView
          title="Location Search Failed"
          description={state.searchError}
          icon={Icon.Warning}
        />
      )}
    </List>
  );
}

function SearchResultActions({
  result,
  onChange,
}: {
  result: LocationSearchResult;
  onChange: LocationChange;
}) {
  const location: WeatherLocation = {
    geohash: result.geohash,
    id: result.id,
    name: result.name,
    state: result.state,
    postcode: result.postcode,
  };

  return (
    <ActionPanel>
      <Action
        title="Save Location"
        icon={Icon.Plus}
        onAction={async () => {
          await runLocationAction("Save location", async () => {
            const locationState = await saveLocation(location);
            onChange(locationState);
            await showToast({
              style: Toast.Style.Success,
              title: "Saved location",
              message: result.name,
            });
          });
        }}
      />
      <Action
        title="Save and Set as Default"
        icon={Icon.Star}
        onAction={async () => {
          await runLocationAction("Set default location", async () => {
            const locationState = await saveLocation(location, true);
            onChange(locationState);
            await showToast({
              style: Toast.Style.Success,
              title: "Default location set",
              message: result.name,
            });
          });
        }}
      />
      <Action.Push
        title="Show Terms and Attribution"
        icon={Icon.Info}
        target={<TermsDetail />}
      />
    </ActionPanel>
  );
}

function SavedLocationActions({
  location,
  isDefault,
  onChange,
}: {
  location: WeatherLocation;
  isDefault: boolean;
  onChange: LocationChange;
}) {
  return (
    <ActionPanel>
      {!isDefault && (
        <Action
          title="Set as Default"
          icon={Icon.Star}
          onAction={async () => {
            await runLocationAction("Set default location", async () => {
              const locationState = await setDefaultLocation(location);
              onChange(locationState);
              await showToast({
                style: Toast.Style.Success,
                title: "Default location set",
                message: location.name,
              });
            });
          }}
        />
      )}
      <Action
        title="Remove Location"
        icon={Icon.Trash}
        style={Action.Style.Destructive}
        onAction={async () => {
          await runLocationAction("Remove location", async () => {
            const locationState = await removeLocation(location);
            onChange({
              saved: locationState.saved,
              defaultGeohash: locationState.defaultGeohash ?? null,
            });
            await showToast({
              style: Toast.Style.Success,
              title: "Removed location",
              message: location.name,
            });
          });
        }}
      />
      <Action.Push
        title="Show Terms and Attribution"
        icon={Icon.Info}
        target={<TermsDetail />}
      />
    </ActionPanel>
  );
}

function TermsDetail() {
  return <Detail markdown={attributionMarkdown()} />;
}

async function runLocationAction(title: string, action: () => Promise<void>) {
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
