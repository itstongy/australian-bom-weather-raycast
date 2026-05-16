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
import {
  getDefaultLocation,
  getSavedLocations,
  setDefaultLocation,
} from "./location-store";
import { configureRuntime } from "./runtime";
import {
  fetchWeatherBundle,
  formatDay,
  formatHour,
  iconForDescriptor,
  summarizeCurrentWeather,
  WeatherLocation,
  WeatherBundle,
} from "./weather";

configureRuntime();

type State =
  | { status: "loading" }
  | { status: "locations"; locations: WeatherLocation[] }
  | { status: "forecast"; bundle: WeatherBundle; locations: WeatherLocation[] }
  | { status: "error"; message: string };

export default function Command() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    Promise.all([getSavedLocations(), getDefaultLocation()])
      .then(([locations, defaultLocation]) => {
        if (defaultLocation) {
          return fetchWeatherBundle(defaultLocation).then((bundle) =>
            setState({ status: "forecast", bundle, locations }),
          );
        }
        setState({ status: "locations", locations });
      })
      .catch((error) =>
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  }, []);

  if (state.status === "loading")
    return <List isLoading searchBarPlaceholder="Loading saved locations..." />;
  if (state.status === "error")
    return (
      <Detail
        markdown={`# BoM Forecast\n\n\`\`\`text\n${state.message}\n\`\`\``}
      />
    );
  if (state.status === "locations")
    return <LocationPicker locations={state.locations} onPick={setState} />;
  return (
    <ForecastList
      bundle={state.bundle}
      locations={state.locations}
      onPick={setState}
    />
  );
}

function LocationPicker({
  locations,
  onPick,
}: {
  locations: WeatherLocation[];
  onPick: (state: State) => void;
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
                  onAction={async () => {
                    try {
                      const bundle = await fetchWeatherBundle(location);
                      onPick({ status: "forecast", bundle, locations });
                    } catch (error) {
                      await showToast({
                        style: Toast.Style.Failure,
                        title: "Could not load forecast",
                        message: errorMessage(error),
                      });
                    }
                  }}
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
  onPick,
}: {
  bundle: WeatherBundle;
  locations: WeatherLocation[];
  onPick: (state: State) => void;
}) {
  const current = summarizeCurrentWeather(bundle);
  const hours = bundle.hourly.data.slice(0, 18);

  return (
    <List
      navigationTitle={`${bundle.location.name} Forecast`}
      searchBarPlaceholder="Search daily and hourly forecast"
    >
      <List.Section title="Current">
        <List.Item
          title={`${current.icon} ${current.shortText}`}
          subtitle={`${Math.round(current.temp)}° · feels ${Math.round(current.feelsLike)}° · ${current.rainChance}% rain`}
          accessories={[
            { text: current.wind },
            current.humidity ? { text: `${current.humidity}% RH` } : {},
          ]}
          actions={
            <ForecastActions
              bundle={bundle}
              locations={locations}
              onPick={onPick}
            />
          }
        />
      </List.Section>

      <List.Section title="Daily">
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
                  onPick={onPick}
                  selectedDayDate={day.date}
                />
              }
            />
          );
        })}
      </List.Section>

      <List.Section title="Hourly">
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
                  onPick={onPick}
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
  onPick,
  selectedDayDate,
}: {
  bundle: WeatherBundle;
  locations: WeatherLocation[];
  onPick: (state: State) => void;
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
            onAction={async () => {
              try {
                const nextBundle = await fetchWeatherBundle(location);
                onPick({ status: "forecast", bundle: nextBundle, locations });
              } catch (error) {
                await showToast({
                  style: Toast.Style.Failure,
                  title: "Could not switch location",
                  message: errorMessage(error),
                });
              }
            }}
          />
        ))}
      </ActionPanel.Submenu>
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
    ? bundle.warnings
        .map(
          (warning) =>
            `- ${warning.title ?? warning.short_title ?? warning.type ?? "Warning"}`,
        )
        .join("\n")
    : "No current warnings for this location.";

  const markdown = [
    `# ${bundle.location.name}`,
    "",
    `## Now`,
    "",
    `${current.icon} **${current.shortText}**`,
    "",
    `- Temperature: ${Math.round(current.temp)}° (feels ${Math.round(current.feelsLike)}°)`,
    `- Rain: ${current.rainChance}% · ${current.rainRange}`,
    `- Wind: ${current.wind}`,
    current.humidity ? `- Humidity: ${current.humidity}%` : "",
    current.todayMax ? `- Max: ${Math.round(current.todayMax)}°` : "",
    current.overnightMin
      ? `- Overnight min: ${Math.round(current.overnightMin)}°`
      : "",
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
