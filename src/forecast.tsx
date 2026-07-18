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
  LatestRequestLifecycle,
} from "./latest-request-lifecycle";
import {
  getDefaultLocation,
  getSavedLocations,
  setDefaultLocation,
} from "./location-store";
import { configureRuntime } from "./runtime";
import {
  fetchWeatherBundle,
  forcedWeatherRefreshSucceeded,
  formatDay,
  formatHour,
  currentWeatherMeta,
  currentWeatherFeedMeta,
  iconForDescriptor,
  summarizeCurrentWeather,
  weatherDataLabel,
  WeatherLocation,
  WeatherBundle,
} from "./weather";

configureRuntime();

type State =
  | { status: "loading" }
  | { status: "locations"; locations: WeatherLocation[] }
  | { status: "forecast"; bundle: WeatherBundle; locations: WeatherLocation[] }
  | { status: "error"; message: string };

type ForecastLoadReason = "view" | "switch" | "refresh";
type LoadForecast = (
  location: WeatherLocation,
  locations: WeatherLocation[],
  reason: ForecastLoadReason,
) => void;

export default function Command() {
  const [state, setState] = useState<State>({ status: "loading" });
  const lifecycleRef = useRef<LatestRequestLifecycle | null>(null);
  if (!lifecycleRef.current) {
    lifecycleRef.current = createLatestRequestLifecycle();
  }
  const lifecycle = lifecycleRef.current;

  const loadForecast = useCallback<LoadForecast>(
    (location, locations, reason) => {
      void lifecycle.run(
        (signal) =>
          fetchWeatherBundle(location, {
            forceRefresh: reason === "refresh",
            signal,
          }),
        {
          onSuccess: (bundle) => {
            setState({ status: "forecast", bundle, locations });
            if (reason === "refresh") {
              void showToast(
                forcedWeatherRefreshSucceeded(bundle)
                  ? {
                      style: Toast.Style.Success,
                      title: "Forecast refreshed",
                    }
                  : {
                      style: Toast.Style.Failure,
                      title: "Could not refresh forecast",
                      message:
                        currentWeatherMeta(bundle).error ??
                        "BoM could not be reached; cached weather is shown.",
                    },
              );
            }
          },
          onError: (error) => {
            void showToast({
              style: Toast.Style.Failure,
              title:
                reason === "refresh"
                  ? "Could not refresh forecast"
                  : reason === "switch"
                    ? "Could not switch location"
                    : "Could not load forecast",
              message: errorMessage(error),
            });
          },
        },
      );
    },
    [lifecycle],
  );

  useEffect(() => {
    void lifecycle.run(
      async (signal) => {
        const [locations, defaultLocation] = await Promise.all([
          getSavedLocations(),
          getDefaultLocation(),
        ]);
        signal.throwIfAborted();
        if (!defaultLocation)
          return { status: "locations", locations } as State;
        const bundle = await fetchWeatherBundle(defaultLocation, { signal });
        return { status: "forecast", bundle, locations } as State;
      },
      {
        onSuccess: setState,
        onError: (error) =>
          setState({ status: "error", message: errorMessage(error) }),
      },
    );
    return () => {
      lifecycle.dispose();
    };
  }, [lifecycle]);

  if (state.status === "loading")
    return <List isLoading searchBarPlaceholder="Loading saved locations..." />;
  if (state.status === "error")
    return (
      <Detail
        markdown={`# BoM Forecast\n\n\`\`\`text\n${state.message}\n\`\`\``}
      />
    );
  if (state.status === "locations")
    return (
      <LocationPicker
        locations={state.locations}
        onLoadForecast={loadForecast}
      />
    );
  return (
    <ForecastList
      bundle={state.bundle}
      locations={state.locations}
      onLoadForecast={loadForecast}
    />
  );
}

function LocationPicker({
  locations,
  onLoadForecast,
}: {
  locations: WeatherLocation[];
  onLoadForecast: LoadForecast;
}) {
  if (locations.length === 0) {
    return (
      <List searchBarPlaceholder="No saved locations">
        <List.EmptyView
          title="No Weather Location"
          description="Run Manage Weather Locations to search and save a BoM forecast location."
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

  return (
    <List searchBarPlaceholder="Select forecast location">
      <List.Section title="Saved Locations">
        {locations.map((location) => (
          <List.Item
            key={location.geohash}
            title={location.name}
            subtitle={[location.state, location.postcode]
              .filter(Boolean)
              .join(" ")}
            accessories={[{ text: location.geohash }]}
            actions={
              <ActionPanel>
                <Action
                  title="View Forecast"
                  icon={Icon.Cloud}
                  onAction={() => onLoadForecast(location, locations, "view")}
                />
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
                <Action.Push
                  title="Manage Locations"
                  icon={Icon.MagnifyingGlass}
                  target={<LocationManagementHint />}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

function ForecastList({
  bundle,
  locations,
  onLoadForecast,
}: {
  bundle: WeatherBundle;
  locations: WeatherLocation[];
  onLoadForecast: LoadForecast;
}) {
  const current = summarizeCurrentWeather(bundle);
  const hours = bundle.hourly.data.slice(0, 18);
  const currentMeta = currentWeatherMeta(bundle);

  return (
    <List
      navigationTitle={`${bundle.location.name} Forecast`}
      searchBarPlaceholder="Search daily and hourly forecast"
    >
      <List.Section title="Current">
        <List.Item
          title={`${current.icon} ${current.shortText}`}
          subtitle={`${formatTemperature(current.temp)} · feels ${formatTemperature(current.feelsLike)} · ${formatRainChance(current.rainChance)} rain`}
          accessories={[
            { text: current.wind },
            current.humidity !== undefined
              ? { text: `${current.humidity}% RH` }
              : {},
            currentMeta.status !== "fresh"
              ? { text: weatherDataLabel(currentMeta) }
              : {},
          ]}
          actions={
            <ForecastActions
              bundle={bundle}
              locations={locations}
              onLoadForecast={onLoadForecast}
            />
          }
        />
      </List.Section>

      <List.Section title="Warnings">
        <List.Item
          title={warningSummaryTitle(bundle)}
          subtitle={`${bundle.location.name} · ${weatherDataLabel(bundle.sources.warnings)}`}
          icon={
            bundle.warnings.length || bundle.sources.warnings.status !== "fresh"
              ? Icon.ExclamationMark
              : Icon.CheckCircle
          }
          actions={
            <ForecastActions
              bundle={bundle}
              locations={locations}
              onLoadForecast={onLoadForecast}
            />
          }
        />
      </List.Section>

      <List.Section
        title={`Daily · ${weatherDataLabel(bundle.sources.daily)}`}
        subtitle={feedIssueSubtitle(bundle.sources.daily.issueTime)}
      >
        {bundle.daily.data.length === 0 && (
          <List.Item
            title="Daily forecast unavailable"
            subtitle={
              bundle.sources.daily.error ??
              "No valid daily forecast was returned."
            }
            icon={Icon.ExclamationMark}
          />
        )}
        {bundle.daily.data.map((day) => {
          const formatted = formatDay(day);
          return (
            <List.Item
              key={day.date}
              title={`${iconForDescriptor(day.icon_descriptor)} ${formatted.label}`}
              subtitle={day.short_text ?? ""}
              accessories={[{ text: formatted.temp }, { text: formatted.rain }]}
              actions={
                <ForecastActions
                  bundle={bundle}
                  locations={locations}
                  onLoadForecast={onLoadForecast}
                  selectedDayDate={day.date}
                />
              }
            />
          );
        })}
      </List.Section>

      <List.Section
        title={`Hourly · ${weatherDataLabel(bundle.sources.hourly)}`}
        subtitle={feedIssueSubtitle(bundle.sources.hourly.issueTime)}
      >
        {hours.length === 0 && (
          <List.Item
            title="Hourly forecast unavailable"
            subtitle={
              bundle.sources.hourly.error ??
              "No valid hourly forecast was returned."
            }
            icon={Icon.ExclamationMark}
          />
        )}
        {hours.map((hour) => {
          const formatted = formatHour(hour);
          return (
            <List.Item
              key={hour.time}
              title={`${iconForDescriptor(hour.icon_descriptor, hour.is_night)} ${formatted.time}`}
              subtitle={`${formatted.temp} · feels ${Math.round(hour.temp_feels_like)}°`}
              accessories={[{ text: formatted.rain }, { text: formatted.wind }]}
              actions={
                <ForecastActions
                  bundle={bundle}
                  locations={locations}
                  onLoadForecast={onLoadForecast}
                />
              }
            />
          );
        })}
      </List.Section>
    </List>
  );
}

function ForecastActions({
  bundle,
  locations,
  onLoadForecast,
  selectedDayDate,
}: {
  bundle: WeatherBundle;
  locations: WeatherLocation[];
  onLoadForecast: LoadForecast;
  selectedDayDate?: string;
}) {
  return (
    <ActionPanel>
      <Action.Push
        title="Show Forecast Details"
        icon={Icon.Sidebar}
        target={
          <ForecastDetail bundle={bundle} selectedDayDate={selectedDayDate} />
        }
      />
      <ActionPanel.Submenu title="Switch Location…" icon={Icon.Map}>
        {locations.map((location) => (
          <Action
            key={location.geohash}
            title={location.name}
            onAction={() => onLoadForecast(location, locations, "switch")}
          />
        ))}
      </ActionPanel.Submenu>
      <Action
        title="Refresh Forecast"
        icon={Icon.ArrowClockwise}
        onAction={() => onLoadForecast(bundle.location, locations, "refresh")}
      />
      <Action
        title="Set Location as Default"
        icon={Icon.Star}
        onAction={async () => {
          await setDefaultLocation(bundle.location);
          await showToast({
            style: Toast.Style.Success,
            title: "Default location set",
            message: bundle.location.name,
          });
        }}
      />
      <Action
        title="Open Radar Browser"
        icon={Icon.Dot}
        onAction={async () =>
          launchCommand({ name: "radar", type: LaunchType.UserInitiated })
        }
      />
      <Action
        title="Manage Locations"
        icon={Icon.MagnifyingGlass}
        onAction={async () =>
          launchCommand({ name: "locations", type: LaunchType.UserInitiated })
        }
      />
      <Action
        title="Open Weather Warnings"
        icon={Icon.ExclamationMark}
        onAction={async () =>
          launchCommand({ name: "warnings", type: LaunchType.UserInitiated })
        }
      />
    </ActionPanel>
  );
}

function ForecastDetail({
  bundle,
  selectedDayDate,
}: {
  bundle: WeatherBundle;
  selectedDayDate?: string;
}) {
  const current = summarizeCurrentWeather(bundle);
  const selectedDay =
    bundle.daily.data.find((day) => day.date === selectedDayDate) ??
    bundle.daily.data[0];
  const warnings = bundle.warnings.length
    ? [
        bundle.sources.warnings.status === "stale"
          ? `> **Last known warnings — ${weatherDataLabel(bundle.sources.warnings)}.** Refresh or open Weather Warnings to verify.`
          : "",
        ...bundle.warnings.map(
          (warning) =>
            `- ${warning.title ?? warning.short_title ?? warning.type ?? "Warning"}`,
        ),
        bundle.expiredWarningCount
          ? `_${bundle.expiredWarningCount} expired warning${bundle.expiredWarningCount === 1 ? " was" : "s were"} hidden._`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : bundle.sources.warnings.status === "fresh"
      ? "BoM reported no current warnings for this location."
      : `> **Current warnings could not be verified.** ${weatherDataLabel(bundle.sources.warnings)}${bundle.sources.warnings.error ? ` — ${bundle.sources.warnings.error}` : ""}`;
  const currentMeta = currentWeatherMeta(bundle);
  const feedMeta = currentWeatherFeedMeta(bundle);

  const markdown = [
    `# ${bundle.location.name}`,
    "",
    `## Now`,
    "",
    `${current.icon} **${current.shortText}**`,
    "",
    `- Temperature: ${formatTemperature(current.temp)} (feels ${formatTemperature(current.feelsLike)})`,
    `- Rain: ${formatRainChance(current.rainChance)} · ${current.rainRange}`,
    `- Wind: ${current.wind}`,
    current.humidity !== undefined ? `- Humidity: ${current.humidity}%` : "",
    current.todayMax !== undefined
      ? `- Max: ${Math.round(current.todayMax)}°`
      : "",
    current.overnightMin !== undefined
      ? `- Overnight min: ${Math.round(current.overnightMin)}°`
      : "",
    `- Combined data state: ${weatherDataLabel(currentMeta)}`,
    ...feedMeta.map(
      ({ label, meta }) =>
        `- ${label}: ${weatherDataLabel(meta)}${meta.issueTime ? ` · issued ${formatIssueTime(meta.issueTime)}` : ""}`,
    ),
    "",
    selectedDay
      ? `## ${new Date(selectedDay.date).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}`
      : "## Daily Forecast",
    "",
    selectedDay?.extended_text ??
      selectedDay?.short_text ??
      "No daily forecast data was returned for this location.",
    "",
    `## Warnings`,
    "",
    warnings,
    "",
    attributionMarkdown(),
  ]
    .filter(Boolean)
    .join("\n");

  return <Detail markdown={markdown} />;
}

function LocationManagementHint() {
  return (
    <Detail markdown="# Manage Locations\n\nRun the **Manage Weather Locations** command to search and save locations." />
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatTemperature(value: number | null) {
  return value == null ? "Unavailable" : `${Math.round(value)}°`;
}

function formatRainChance(value: number | null) {
  return value == null ? "Unavailable" : `${Math.round(value)}%`;
}

function formatIssueTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function feedIssueSubtitle(value?: string) {
  return value ? `Issued ${formatIssueTime(value)}` : undefined;
}

function warningSummaryTitle(bundle: WeatherBundle) {
  if (bundle.warnings.length) {
    const noun = `warning${bundle.warnings.length === 1 ? "" : "s"}`;
    return bundle.sources.warnings.status === "stale"
      ? `${bundle.warnings.length} last known ${noun}`
      : `${bundle.warnings.length} current ${noun}`;
  }
  return bundle.sources.warnings.status === "fresh"
    ? "No current warnings"
    : "Could not verify current warnings";
}
