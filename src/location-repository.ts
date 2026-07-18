import {
  normalizeLocationGeohash,
  normalizeStoredLocation,
  sanitizeStoredLocations,
  selectDefaultLocation,
} from "./location-selection";
import type { WeatherLocation } from "./weather";

export const SAVED_LOCATIONS_KEY = "saved-weather-locations";
export const DEFAULT_LOCATION_KEY = "default-weather-location";

export type LocationStorage = {
  getItem(key: string): Promise<string | undefined>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export type LocationState = {
  saved: WeatherLocation[];
  defaultGeohash?: string;
};

export function createLocationRepository(storage: LocationStorage) {
  async function getSavedLocations(): Promise<WeatherLocation[]> {
    const raw = await storage.getItem(SAVED_LOCATIONS_KEY);
    const locations = sanitizeStoredLocations(parseJson(raw));
    const repaired = JSON.stringify(locations);
    if (raw !== repaired) await storage.setItem(SAVED_LOCATIONS_KEY, repaired);
    return locations;
  }

  async function resolveState(
    saved: WeatherLocation[],
    storedDefault?: string,
  ): Promise<LocationState> {
    const selected = selectDefaultLocation(saved, storedDefault);
    if (selected) {
      if (storedDefault !== selected.geohash) {
        await storage.setItem(DEFAULT_LOCATION_KEY, selected.geohash);
      }
      return { saved, defaultGeohash: selected.geohash };
    }
    if (storedDefault !== undefined) {
      await storage.removeItem(DEFAULT_LOCATION_KEY);
    }
    return { saved };
  }

  async function getLocationState(): Promise<LocationState> {
    const [saved, storedDefault] = await Promise.all([
      getSavedLocations(),
      storage.getItem(DEFAULT_LOCATION_KEY),
    ]);
    return resolveState(saved, storedDefault);
  }

  async function saveLocation(
    location: WeatherLocation,
    makeDefault = false,
  ): Promise<LocationState> {
    const saved = await getSavedLocations();
    const normalized = normalizeStoredLocation(location);
    if (!normalized) throw new Error("Location has an invalid name or geohash");
    const next = [
      normalized,
      ...saved.filter((item) => item.geohash !== normalized.geohash),
    ];
    await storage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify(next));

    const storedDefault = await storage.getItem(DEFAULT_LOCATION_KEY);
    if (makeDefault || saved.length === 0) {
      await storage.setItem(DEFAULT_LOCATION_KEY, normalized.geohash);
      return { saved: next, defaultGeohash: normalized.geohash };
    }
    return resolveState(next, storedDefault);
  }

  async function removeLocation(
    location: WeatherLocation,
  ): Promise<LocationState> {
    const saved = await getSavedLocations();
    const geohash = normalizeLocationGeohash(location.geohash);
    if (!geohash) throw new Error("Location has an invalid geohash");
    const next = saved.filter((item) => item.geohash !== geohash);
    await storage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify(next));
    return resolveState(next, await storage.getItem(DEFAULT_LOCATION_KEY));
  }

  async function setDefaultLocation(
    location: WeatherLocation,
  ): Promise<LocationState> {
    const state = await saveLocation(location);
    const normalized = normalizeStoredLocation(location);
    if (!normalized) throw new Error("Location has an invalid name or geohash");
    await storage.setItem(DEFAULT_LOCATION_KEY, normalized.geohash);
    return { saved: state.saved, defaultGeohash: normalized.geohash };
  }

  async function getDefaultLocation(): Promise<WeatherLocation | null> {
    const state = await getLocationState();
    return (
      state.saved.find(
        (location) => location.geohash === state.defaultGeohash,
      ) ?? null
    );
  }

  return {
    getSavedLocations,
    getDefaultLocation,
    getLocationState,
    saveLocation,
    removeLocation,
    setDefaultLocation,
  };
}

function parseJson(raw?: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
