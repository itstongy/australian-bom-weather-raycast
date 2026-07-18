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
import { useCallback, useEffect, useRef, useState } from "react";
import { attributionMarkdown } from "./attribution";
import {
  createLatestRequestLifecycle,
  isAbortError,
  LatestRequestLifecycle,
} from "./latest-request-lifecycle";
import { getDefaultLocation, getSavedLocations } from "./location-store";
import { configureRuntime } from "./runtime";
import {
  fetchWarningsForLocation,
  fetchWarningDetail,
  Warning,
  WeatherLocation,
  WarningsResult,
  weatherDataLabel,
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
      result: WarningsResult;
    }
  | { status: "error"; message: string };

type WarningsLoadReason = "initial" | "switch" | "refresh";
type RequestWarnings = (
  location: WeatherLocation | undefined,
  reason: WarningsLoadReason,
) => void;

export default function Command() {
  const [state, setState] = useState<State>({ status: "loading" });
  const lifecycleRef = useRef<LatestRequestLifecycle | null>(null);
  if (!lifecycleRef.current) {
    lifecycleRef.current = createLatestRequestLifecycle();
  }
  const lifecycle = lifecycleRef.current;

  const requestWarnings = useCallback<RequestWarnings>(
    (location, reason) => {
      void lifecycle.run(
        (signal) =>
          loadWarnings(location, {
            forceRefresh: reason === "refresh",
            signal,
          }),
        {
          onSuccess: (nextState) => {
            setState(nextState);
            if (reason === "refresh") {
              void showToast(
                nextState.result.meta.source === "network"
                  ? {
                      style: Toast.Style.Success,
                      title: "Warnings refreshed",
                    }
                  : {
                      style: Toast.Style.Failure,
                      title: "Could not refresh warnings",
                      message:
                        nextState.result.meta.error ??
                        "BoM could not be reached; cached warnings are shown.",
                    },
              );
            }
          },
          onError: (error) => {
            if (reason === "initial") {
              setState({ status: "error", message: errorMessage(error) });
              return;
            }
            void showToast({
              style: Toast.Style.Failure,
              title:
                reason === "refresh"
                  ? "Could not refresh warnings"
                  : "Could not load warnings",
              message: errorMessage(error),
            });
          },
        },
      );
    },
    [lifecycle],
  );

  useEffect(() => {
    requestWarnings(undefined, "initial");
    return () => {
      lifecycle.dispose();
    };
  }, [lifecycle, requestWarnings]);

  if (state.status === "loading")
    return <List isLoading searchBarPlaceholder="Loading BoM warnings..." />;
  if (state.status === "error")
    return (
      <Detail
        markdown={`# Weather Warnings\n\n\`\`\`text\n${state.message}\n\`\`\``}
      />
    );

  return <WarningsList state={state} onRequest={requestWarnings} />;
}

async function loadWarnings(
  location?: WeatherLocation,
  options: { forceRefresh?: boolean; signal?: AbortSignal } = {},
): Promise<Extract<State, { status: "ready" }>> {
  const locations = await getSavedLocations();
  options.signal?.throwIfAborted();
  const selected = location ?? (await getDefaultLocation());
  options.signal?.throwIfAborted();
  if (!selected) {
    return {
      status: "ready",
      location: { geohash: "", name: "No Location" },
      locations,
      result: {
        warnings: [],
        meta: {
          status: "unavailable",
          source: "none",
          error: "No weather location is configured.",
        },
        expiredCount: 0,
      },
    };
  }
  const result = await fetchWarningsForLocation(selected, options);
  return { status: "ready", location: selected, locations, result };
}

function WarningsList({
  state,
  onRequest,
}: {
  state: Extract<State, { status: "ready" }>;
  onRequest: RequestWarnings;
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

  const { warnings, meta, expiredCount } = state.result;

  if (meta.status !== "fresh" && warnings.length === 0) {
    return (
      <List navigationTitle={`${state.location.name} Warnings`}>
        <List.EmptyView
          title="Could Not Verify Current Warnings"
          description={`BoM warnings are ${weatherDataLabel(meta).toLowerCase()}. ${meta.error ?? "Refresh to try again."}`}
          icon={Icon.ExclamationMark}
        />
        <List.Item
          title="Current warnings are unverified"
          subtitle={`${weatherDataLabel(meta)}${meta.error ? ` · ${meta.error}` : ""}`}
          icon={Icon.ExclamationMark}
          actions={<WarningsActions state={state} onRequest={onRequest} />}
        />
      </List>
    );
  }

  if (warnings.length === 0) {
    return (
      <List navigationTitle={`${state.location.name} Warnings`}>
        <List.EmptyView
          title="No Current Warnings"
          description={`BoM reported no current warnings for ${state.location.name} (${weatherDataLabel(meta).toLowerCase()}).${expiredCount ? ` ${expiredCount} expired warning${expiredCount === 1 ? " was" : "s were"} hidden.` : ""}`}
        />
        <List.Item
          title="No current warnings"
          subtitle={state.location.name}
          icon={Icon.CheckCircle}
          accessories={[{ text: weatherDataLabel(meta) }]}
          actions={<WarningsActions state={state} onRequest={onRequest} />}
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
        title={`${meta.status === "stale" ? "Last Known" : "Current"} Warning${warnings.length === 1 ? "" : "s"} · ${weatherDataLabel(meta)}`}
        subtitle={expiredCount ? `${expiredCount} expired hidden` : undefined}
      >
        {warnings.map((warning) => (
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
                <WarningsActions state={state} onRequest={onRequest} />
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
  onRequest,
}: {
  state: Extract<State, { status: "ready" }>;
  onRequest: RequestWarnings;
}) {
  return (
    <>
      <ActionPanel.Submenu title="Switch Location…" icon={Icon.Map}>
        {state.locations.map((location) => (
          <Action
            key={location.geohash}
            title={location.name}
            onAction={() => onRequest(location, "switch")}
          />
        ))}
      </ActionPanel.Submenu>
      <Action
        title="Refresh Warnings"
        icon={Icon.ArrowClockwise}
        onAction={() => onRequest(state.location, "refresh")}
      />
    </>
  );
}

function WarningDetail({ warning }: { warning: Warning }) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; warning: Warning; label: string }
    | { status: "error"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetchWarningDetail(warning, { signal: controller.signal })
      .then(
        (result) =>
          active &&
          setState({
            status: "ready",
            warning: result.warning,
            label: weatherDataLabel(result.meta),
          }),
      )
      .catch((error) => {
        if (active && !isAbortError(error))
          setState({ status: "error", message: errorMessage(error) });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [warning.id]);

  if (state.status === "loading") {
    return <Detail isLoading markdown="# Loading Warning Details…" />;
  }
  if (state.status === "error") {
    return (
      <Detail
        markdown={`${warningMarkdown(warning)}\n\n> **Could not load the full warning message:** ${state.message}\n\n${attributionMarkdown()}`}
      />
    );
  }
  return (
    <Detail
      markdown={`${warningMarkdown(state.warning)}\n\n_Detail data: ${state.label}_\n\n${attributionMarkdown()}`}
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
