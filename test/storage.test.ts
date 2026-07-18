import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeLocationGeohash,
  normalizeStoredLocation,
  sanitizeStoredLocations,
  selectDefaultLocation,
} from "../src/location-selection";
import {
  createLocationRepository,
  DEFAULT_LOCATION_KEY,
  LocationStorage,
  SAVED_LOCATIONS_KEY,
} from "../src/location-repository";
import {
  normalizeFrameCount,
  normalizeRadarProductId,
  sanitizeFavoriteIds,
} from "../src/radar-selection";

test("location geohashes are normalized and strictly validated", () => {
  assert.equal(normalizeLocationGeohash(" QLD-Brisbane-R7HGDP9 "), "r7hgdp");
  assert.equal(normalizeLocationGeohash("r7hgdp"), "r7hgdp");
  assert.equal(normalizeLocationGeohash("abcdef"), undefined);
  assert.equal(normalizeLocationGeohash("r7h"), undefined);
  assert.equal(normalizeLocationGeohash(null), undefined);
});

test("stored locations drop malformed fields and duplicate geohashes", () => {
  assert.deepEqual(
    sanitizeStoredLocations([
      {
        geohash: "R7HGDP9",
        name: " Brisbane ",
        state: " QLD ",
        postcode: 4000,
      },
      { geohash: "r7hgdp", name: "Duplicate" },
      { geohash: "invalid", name: "Invalid" },
      { geohash: "r3gx2f" },
      null,
    ]),
    [{ geohash: "r7hgdp", name: "Brisbane", state: "QLD" }],
  );
  assert.equal(normalizeStoredLocation({ geohash: "r7hgdp", name: " " }), null);
});

test("default location selection accepts a normalized stored key", () => {
  const locations = [
    { geohash: "r7hgdp", name: "Brisbane" },
    { geohash: "r3gx2f", name: "Sydney" },
  ];
  assert.equal(
    selectDefaultLocation(locations, "NSW-Sydney-R3GX2F9")?.name,
    "Sydney",
  );
});

test("location repository persists and returns default-marker state across removal and re-save", async () => {
  const values = new Map<string, string>();
  const storage: LocationStorage = {
    async getItem(key) {
      return values.get(key);
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async removeItem(key) {
      values.delete(key);
    },
  };
  const repository = createLocationRepository(storage);
  const firstLocation = { geohash: "r7hgdp", name: "Brisbane" };
  const secondLocation = { geohash: "r3gx2f", name: "Sydney" };

  assert.deepEqual(await repository.saveLocation(firstLocation), {
    saved: [firstLocation],
    defaultGeohash: firstLocation.geohash,
  });
  assert.equal(values.get(DEFAULT_LOCATION_KEY), firstLocation.geohash);
  assert.deepEqual(JSON.parse(values.get(SAVED_LOCATIONS_KEY) ?? "null"), [
    firstLocation,
  ]);

  assert.deepEqual(await repository.saveLocation(secondLocation), {
    saved: [secondLocation, firstLocation],
    defaultGeohash: firstLocation.geohash,
  });
  assert.deepEqual(await repository.removeLocation(secondLocation), {
    saved: [firstLocation],
    defaultGeohash: firstLocation.geohash,
  });
  assert.deepEqual(await repository.removeLocation(firstLocation), {
    saved: [],
  });
  assert.equal(values.has(DEFAULT_LOCATION_KEY), false);

  assert.deepEqual(await repository.saveLocation(secondLocation), {
    saved: [secondLocation],
    defaultGeohash: secondLocation.geohash,
  });
  assert.equal(values.get(DEFAULT_LOCATION_KEY), secondLocation.geohash);
  assert.deepEqual(await repository.getLocationState(), {
    saved: [secondLocation],
    defaultGeohash: secondLocation.geohash,
  });
});

test("location repository repairs a missing default for active UI state", async () => {
  const firstLocation = { geohash: "r7hgdp", name: "Brisbane" };
  const values = new Map<string, string>([
    [SAVED_LOCATIONS_KEY, JSON.stringify([firstLocation])],
    [DEFAULT_LOCATION_KEY, "r3gx2f"],
  ]);
  const repository = createLocationRepository({
    getItem: async (key) => values.get(key),
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  });

  assert.deepEqual(await repository.getLocationState(), {
    saved: [firstLocation],
    defaultGeohash: firstLocation.geohash,
  });
  assert.equal(
    values.get(DEFAULT_LOCATION_KEY),
    firstLocation.geohash,
  );
});

test("radar favorites retain only unique valid product IDs", () => {
  assert.deepEqual(
    sanitizeFavoriteIds([" idr663 ", "IDR66A", "IDR663", 12, "bad"]),
    ["IDR663", "IDR66A"],
  );
  assert.equal(normalizeRadarProductId("idr023"), "IDR023");
  assert.equal(normalizeRadarProductId("IDR1234"), undefined);
});

test("frame count accepts only supported UI options", () => {
  assert.equal(normalizeFrameCount("4"), 4);
  assert.equal(normalizeFrameCount(12), 12);
  assert.equal(normalizeFrameCount("10 frames"), 7);
  assert.equal(normalizeFrameCount(6), 7);
  assert.equal(normalizeFrameCount(undefined), 7);
});
