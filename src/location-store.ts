import { LocalStorage } from "@raycast/api";
import { selectDefaultLocation } from "./location-selection";
import { normalizeGeohash, WeatherLocation } from "./weather";

const SAVED_LOCATIONS_KEY = "saved-weather-locations";
const DEFAULT_LOCATION_KEY = "default-weather-location";

export async function getSavedLocations(): Promise<WeatherLocation[]> {
  return readJson<WeatherLocation[]>(SAVED_LOCATIONS_KEY, []);
}

export async function getDefaultLocation(): Promise<WeatherLocation | null> {
  const [locations, defaultGeohash] = await Promise.all([
    getSavedLocations(),
    LocalStorage.getItem<string>(DEFAULT_LOCATION_KEY),
  ]);
  return selectDefaultLocation(locations, defaultGeohash);
}

export async function saveLocation(
  location: WeatherLocation,
  makeDefault = false,
) {
  const locations = await readJson<WeatherLocation[]>(SAVED_LOCATIONS_KEY, []);
  const normalized = {
    ...location,
    geohash: normalizeGeohash(location.geohash),
  };
  const next = [
    normalized,
    ...locations.filter((item) => item.geohash !== normalized.geohash),
  ];
  await LocalStorage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify(next));
  if (makeDefault)
    await LocalStorage.setItem(DEFAULT_LOCATION_KEY, normalized.geohash);
}

export async function removeLocation(location: WeatherLocation) {
  const locations = await readJson<WeatherLocation[]>(SAVED_LOCATIONS_KEY, []);
  const next = locations.filter((item) => item.geohash !== location.geohash);
  await LocalStorage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify(next));
  const currentDefault =
    await LocalStorage.getItem<string>(DEFAULT_LOCATION_KEY);
  if (currentDefault === location.geohash) {
    if (next[0])
      await LocalStorage.setItem(DEFAULT_LOCATION_KEY, next[0].geohash);
    else await LocalStorage.removeItem(DEFAULT_LOCATION_KEY);
  }
}

export async function setDefaultLocation(location: WeatherLocation) {
  const normalizedGeohash = normalizeGeohash(location.geohash);
  await saveLocation({ ...location, geohash: normalizedGeohash }, false);
  await LocalStorage.setItem(DEFAULT_LOCATION_KEY, normalizedGeohash);
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await LocalStorage.getItem<string>(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
