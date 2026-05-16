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
import {
  getSavedLocations,
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
};

export default function Command() {
  const [state, setState] = useState<State>({
    saved: [],
    results: [],
    isLoadingSaved: true,
    isLoadingSearch: false,
  });
  const [query, setQuery] = useState("");

  useEffect(() => {
    getSavedLocations()
      .then((saved) =>
        setState((current) => ({ ...current, saved, isLoadingSaved: false })),
      )
      .catch(async (error) => {
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
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => {
      if (query.trim().length < 2) {
        setState((current) => ({
          ...current,
          results: [],
          isLoadingSearch: false,
        }));
        return;
      }
      setState((current) => ({ ...current, isLoadingSearch: true }));
      searchLocations(query)
        .then((results) => {
          if (!cancelled)
            setState((current) => ({
              ...current,
              results,
              isLoadingSearch: false,
            }));
        })
        .catch(() => {
          if (!cancelled)
            setState((current) => ({
              ...current,
              results: [],
              isLoadingSearch: false,
            }));
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
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
              accessories={[{ text: location.geohash }]}
              actions={
                <SavedLocationActions
                  location={location}
                  onChange={(saved) =>
                    setState((current) => ({ ...current, saved }))
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
                onChange={(saved) =>
                  setState((current) => ({ ...current, saved }))
                }
              />
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

function SearchResultActions({
  result,
  onChange,
}: {
  result: LocationSearchResult;
  onChange: (saved: WeatherLocation[]) => void;
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
          await saveLocation(location);
          onChange(await getSavedLocations());
          await showToast({
            style: Toast.Style.Success,
            title: "Saved location",
            message: result.name,
          });
        }}
      />
      <Action
        title="Save and Set as Default"
        icon={Icon.Star}
        onAction={async () => {
          await saveLocation(location, true);
          onChange(await getSavedLocations());
          await showToast({
            style: Toast.Style.Success,
            title: "Default location set",
            message: result.name,
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
  onChange,
}: {
  location: WeatherLocation;
  onChange: (saved: WeatherLocation[]) => void;
}) {
  return (
    <ActionPanel>
      <Action
        title="Set as Default"
        icon={Icon.Star}
        onAction={async () => {
          await setDefaultLocation(location);
          await showToast({
            style: Toast.Style.Success,
            title: "Default location set",
            message: location.name,
          });
        }}
      />
      <Action
        title="Remove Location"
        icon={Icon.Trash}
        style={Action.Style.Destructive}
        onAction={async () => {
          await removeLocation(location);
          onChange(await getSavedLocations());
          await showToast({
            style: Toast.Style.Success,
            title: "Removed location",
            message: location.name,
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
