import { LocalStorage } from "@raycast/api";
import { createLocationRepository } from "./location-repository";

const repository = createLocationRepository({
  getItem: (key) => LocalStorage.getItem<string>(key),
  setItem: (key, value) => LocalStorage.setItem(key, value),
  removeItem: (key) => LocalStorage.removeItem(key),
});

export const getSavedLocations = repository.getSavedLocations;
export const getDefaultLocation = repository.getDefaultLocation;
export const getLocationState = repository.getLocationState;
export const saveLocation = repository.saveLocation;
export const removeLocation = repository.removeLocation;
export const setDefaultLocation = repository.setDefaultLocation;
