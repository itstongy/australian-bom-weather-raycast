import {
  environment,
  launchCommand,
  LaunchType,
  updateCommandMetadata,
} from "@raycast/api";
import { getDefaultLocation } from "./location-store";
import { configureRuntime } from "./runtime";
import {
  currentWeatherMeta,
  fetchWeatherBundle,
  summarizeCurrentWeather,
  weatherDataLabel,
} from "./weather";

configureRuntime();

export default async function Command() {
  try {
    const location = await getDefaultLocation();
    if (!location) {
      await updateCommandMetadata({ subtitle: "Set up a location" });
      if (environment.launchType === LaunchType.UserInitiated) {
        await launchCommand({
          name: "locations",
          type: LaunchType.UserInitiated,
        });
      }
      return;
    }
    const bundle = await fetchWeatherBundle(location);
    const current = summarizeCurrentWeather(bundle);
    const meta = currentWeatherMeta(bundle);
    await updateCommandMetadata({
      subtitle:
        current.temp == null
          ? `${location.name}: BoM weather unavailable · ${weatherDataLabel(meta)}`
          : `${location.name}: ${current.icon} ${formatTemperature(current.temp)} · ${formatRainChance(current.rainChance)} rain · ${current.shortText}${meta.status === "fresh" ? "" : ` · ${weatherDataLabel(meta)}`}`,
    });
  } catch {
    await updateCommandMetadata({ subtitle: "BoM weather unavailable" });
  }

  if (environment.launchType === LaunchType.UserInitiated) {
    await launchCommand({ name: "forecast", type: LaunchType.UserInitiated });
  }
}

function formatTemperature(value: number | null) {
  return value == null ? "weather unavailable" : `${Math.round(value)}°`;
}

function formatRainChance(value: number | null) {
  return value == null ? "—" : `${Math.round(value)}%`;
}
