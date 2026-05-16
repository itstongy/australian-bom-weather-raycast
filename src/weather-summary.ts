import {
  environment,
  launchCommand,
  LaunchType,
  updateCommandMetadata,
} from "@raycast/api";
import { getDefaultLocation } from "./location-store";
import { configureRuntime } from "./runtime";
import { fetchWeatherBundle, summarizeCurrentWeather } from "./weather";

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
    await updateCommandMetadata({
      subtitle: `${location.name}: ${current.icon} ${Math.round(current.temp)}° · ${current.rainChance}% rain · ${current.shortText}`,
    });
  } catch {
    await updateCommandMetadata({ subtitle: "BoM weather unavailable" });
  }

  if (environment.launchType === LaunchType.UserInitiated) {
    await launchCommand({ name: "forecast", type: LaunchType.UserInitiated });
  }
}
