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
  fetchWeatherBundle,
  summarizeCurrentWeather,
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
    getDefaultLocation()
      .then((location) => {
        if (!location)
          throw new Error(
            "No weather location saved. Run Manage Weather Locations first.",
          );
        return fetchWeatherBundle(location, { forceRefresh: refreshCount > 0 });
      })
      .then(async (bundle) => {
        setState({ status: "ready", bundle });
        if (refreshCount > 0) {
          await showToast({
            style: Toast.Style.Success,
            title: "Weather refreshed",
          });
        }
      })
      .catch((error) =>
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
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

  return (
    <MenuBarExtra
      title={`${current.icon} ${Math.round(current.temp)}°`}
      tooltip={`${state.bundle.location.name}: ${current.subtitle}`}
    >
      <MenuBarExtra.Section title={state.bundle.location.name}>
        <MenuBarExtra.Item title={current.shortText} />
        <MenuBarExtra.Item
          title={`${Math.round(current.temp)}°`}
          subtitle={`Feels ${Math.round(current.feelsLike)}°`}
        />
        <MenuBarExtra.Item
          title={`${current.rainChance}% rain`}
          subtitle={current.rainRange}
        />
        <MenuBarExtra.Item title="Wind" subtitle={current.wind} />
        {current.humidity !== undefined && (
          <MenuBarExtra.Item
            title="Humidity"
            subtitle={`${current.humidity}%`}
          />
        )}
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
