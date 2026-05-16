import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  launchCommand,
  LaunchType,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { attributionMarkdown } from "./attribution";
import { getDefaultLocation, getSavedLocations } from "./location-store";
import { configureRuntime } from "./runtime";
import {
  fetchWarningsForLocation,
  Warning,
  WeatherLocation,
  warningMarkdown,
  warningSubtitle,
  warningTitle,
} from "./weather";

configureRuntime();

type State =
  | { status: "loading" }
  | {
      status: "ready";
      location: WeatherLocation;
      locations: WeatherLocation[];
      warnings: Warning[];
    }
  | { status: "error"; message: string };

export default function Command() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    loadWarnings()
      .then(setState)
      .catch((error) =>
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  }, []);

  if (state.status === "loading")
    return <List isLoading searchBarPlaceholder="Loading BoM warnings..." />;
  if (state.status === "error")
    return (
      <Detail
        markdown={`# Weather Warnings\n\n\`\`\`text\n${state.message}\n\`\`\``}
      />
    );

  return <WarningsList state={state} onChange={setState} />;
}

async function loadWarnings(
  location?: WeatherLocation,
  options: { forceRefresh?: boolean } = {},
): Promise<Extract<State, { status: "ready" }>> {
  const locations = await getSavedLocations();
  const selected = location ?? (await getDefaultLocation());
  if (!selected) {
    return {
      status: "ready",
      location: { geohash: "", name: "No Location" },
      locations,
      warnings: [],
    };
  }
  const warnings = await fetchWarningsForLocation(selected, options);
  return { status: "ready", location: selected, locations, warnings };
}

function WarningsList({
  state,
  onChange,
}: {
  state: Extract<State, { status: "ready" }>;
  onChange: (state: State) => void;
}) {
  if (!state.location.geohash) {
    return (
      <List navigationTitle="Weather Warnings">
        <List.EmptyView
          title="No Weather Location"
          description="Run Manage Weather Locations to save a BoM location first."
        />
        <List.Item
          title="Manage Weather Locations"
          subtitle="Search and save a BoM forecast location"
          icon={Icon.MagnifyingGlass}
          actions={
            <ActionPanel>
              <Action
                title="Manage Locations"
                icon={Icon.MagnifyingGlass}
                onAction={async () =>
                  launchCommand({
                    name: "locations",
                    type: LaunchType.UserInitiated,
                  })
                }
              />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  if (state.warnings.length === 0) {
    return (
      <List navigationTitle={`${state.location.name} Warnings`}>
        <List.EmptyView
          title="No Current Warnings"
          description={`No BoM warnings for ${state.location.name}.`}
        />
        <List.Item
          title="No current warnings"
          subtitle={state.location.name}
          icon={Icon.CheckCircle}
          actions={<WarningsActions state={state} onChange={onChange} />}
        />
      </List>
    );
  }

  return (
    <List
      navigationTitle={`${state.location.name} Warnings`}
      searchBarPlaceholder="Search warnings"
    >
      <List.Section
        title={`${state.warnings.length} Current Warning${state.warnings.length === 1 ? "" : "s"}`}
      >
        {state.warnings.map((warning) => (
          <List.Item
            key={warning.id ?? warningTitle(warning)}
            title={warningTitle(warning)}
            subtitle={warningSubtitle(warning)}
            accessories={[
              warning.expiry_time
                ? { text: `Expires ${formatShortDate(warning.expiry_time)}` }
                : {},
            ]}
            actions={
              <ActionPanel>
                <Action.Push
                  title="Show Warning Details"
                  icon={Icon.Sidebar}
                  target={<WarningDetail warning={warning} />}
                />
                <WarningsActions state={state} onChange={onChange} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

function WarningsActions({
  state,
  onChange,
}: {
  state: Extract<State, { status: "ready" }>;
  onChange: (state: State) => void;
}) {
  return (
    <>
      <ActionPanel.Submenu title="Switch Location…" icon={Icon.Map}>
        {state.locations.map((location) => (
          <Action
            key={location.geohash}
            title={location.name}
            onAction={async () => {
              try {
                onChange(await loadWarnings(location));
              } catch (error) {
                await showToast({
                  style: Toast.Style.Failure,
                  title: "Could not load warnings",
                  message: errorMessage(error),
                });
              }
            }}
          />
        ))}
      </ActionPanel.Submenu>
      <Action
        title="Refresh Warnings"
        icon={Icon.ArrowClockwise}
        onAction={async () => {
          try {
            onChange(
              await loadWarnings(state.location, { forceRefresh: true }),
            );
          } catch (error) {
            await showToast({
              style: Toast.Style.Failure,
              title: "Could not refresh warnings",
              message: errorMessage(error),
            });
          }
        }}
      />
    </>
  );
}

function WarningDetail({ warning }: { warning: Warning }) {
  return (
    <Detail
      markdown={`${warningMarkdown(warning)}\n\n${attributionMarkdown()}`}
    />
  );
}

function formatShortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
