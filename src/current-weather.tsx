import {
  Icon,
  launchCommand,
  LaunchType,
  MenuBarExtra,
  showToast,
  Toast,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { getDefaultLocation } from "./location-store";
import { configureRuntime } from "./runtime";
import {
  currentWeatherMeta,
  currentWeatherFeedMeta,
  fetchWeatherBundle,
  forcedWeatherRefreshSucceeded,
  summarizeCurrentWeather,
  weatherDataLabel,
  WeatherBundle,
} from "./weather";

configureRuntime();

type State =
  | { status: "loading" }
  | { status: "ready"; bundle: WeatherBundle }
  | { status: "error"; message: string };

export default function Command() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    getDefaultLocation()
      .then((location) => {
        if (!location)
          throw new Error(
            "No weather location saved. Run Manage Weather Locations first.",
          );
        return fetchWeatherBundle(location, {
          forceRefresh: refreshCount > 0,
          signal: controller.signal,
        });
      })
      .then(async (bundle) => {
        if (!active) return;
        setState({ status: "ready", bundle });
        if (refreshCount > 0) {
          const succeeded = forcedWeatherRefreshSucceeded(bundle);
          await showToast(
            succeeded
              ? {
                  style: Toast.Style.Success,
                  title: "Weather and warnings refreshed",
                }
              : {
                  style: Toast.Style.Failure,
                  title: "Weather refresh incomplete",
                  message:
                    "BoM could not refresh observations, forecasts, and warnings; available cached data is still shown.",
                },
          );
        }
      })
      .catch((error) => {
        if (active && !isAbortError(error))
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [refreshCount]);

  if (state.status === "loading") {
    return <MenuBarExtra isLoading title="Weather" icon="🌡️" />;
  }

  if (state.status === "error") {
    return (
      <MenuBarExtra title="Weather" icon="⚠️" tooltip={state.message}>
        <MenuBarExtra.Item title="Could not load BoM weather" />
        <MenuBarExtra.Separator />
        <MenuBarExtra.Item
          title="Configure Location"
          icon={Icon.Gear}
          onAction={() =>
            launchCommand({ name: "locations", type: LaunchType.UserInitiated })
          }
        />
      </MenuBarExtra>
    );
  }

  const current = summarizeCurrentWeather(state.bundle);
  const currentMeta = currentWeatherMeta(state.bundle);
  const feedMeta = currentWeatherFeedMeta(state.bundle);
  const temperature = formatTemperature(current.temp);

  return (
    <MenuBarExtra
      title={`${current.icon} ${temperature}`}
      tooltip={`${state.bundle.location.name}: ${current.subtitle} · ${weatherDataLabel(currentMeta)}`}
    >
      <MenuBarExtra.Section title={state.bundle.location.name}>
        <MenuBarExtra.Item title={current.shortText} />
        <MenuBarExtra.Item
          title={temperature}
          subtitle={`Feels ${formatTemperature(current.feelsLike)}`}
        />
        <MenuBarExtra.Item
          title={`${formatRainChance(current.rainChance)} rain`}
          subtitle={current.rainRange}
        />
        <MenuBarExtra.Item title="Wind" subtitle={current.wind} />
        {current.humidity !== undefined && (
          <MenuBarExtra.Item
            title="Humidity"
            subtitle={`${current.humidity}%`}
          />
        )}
        <MenuBarExtra.Item
          title="Weather data"
          subtitle={weatherDataLabel(currentMeta)}
        />
        {feedMeta.map(({ label, meta }) => (
          <MenuBarExtra.Item
            key={label}
            title={`${label} data`}
            subtitle={`${weatherDataLabel(meta)}${meta.issueTime ? ` · ${formatIssueTime(meta.issueTime)}` : ""}`}
          />
        ))}
        {state.bundle.warnings.length > 0 ? (
          <MenuBarExtra.Item
            title={`${state.bundle.warnings.length} ${state.bundle.sources.warnings.status === "stale" ? "last known" : "current"} warning${state.bundle.warnings.length === 1 ? "" : "s"}`}
            subtitle={weatherDataLabel(state.bundle.sources.warnings)}
            icon={Icon.ExclamationMark}
            onAction={() =>
              launchCommand({
                name: "warnings",
                type: LaunchType.UserInitiated,
              })
            }
          />
        ) : state.bundle.sources.warnings.status !== "fresh" ? (
          <MenuBarExtra.Item
            title="Warnings not verified"
            subtitle={weatherDataLabel(state.bundle.sources.warnings)}
            icon={Icon.ExclamationMark}
            onAction={() =>
              launchCommand({
                name: "warnings",
                type: LaunchType.UserInitiated,
              })
            }
          />
        ) : null}
      </MenuBarExtra.Section>
      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          title="Refresh"
          icon={Icon.ArrowClockwise}
          onAction={() => {
            setState({ status: "loading" });
            setRefreshCount((count) => count + 1);
          }}
        />
        <MenuBarExtra.Item
          title="Configure Location"
          icon={Icon.Gear}
          onAction={() =>
            launchCommand({ name: "locations", type: LaunchType.UserInitiated })
          }
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}

function formatTemperature(value: number | null) {
  return value == null ? "—" : `${Math.round(value)}°`;
}

function formatRainChance(value: number | null) {
  return value == null ? "—" : `${Math.round(value)}%`;
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

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
