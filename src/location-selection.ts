import { WeatherLocation } from "./weather";

export function selectDefaultLocation(
  locations: WeatherLocation[],
  defaultGeohash?: string,
) {
  return (
    locations.find((location) => location.geohash === defaultGeohash) ??
    locations[0] ??
    null
  );
}
