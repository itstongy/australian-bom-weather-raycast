import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { groupRadarSites } from "../src/bom/catalog";
import { addLoopProgressBar, baseOverlayProductId } from "../src/bom/render";
import { isRadarFrame } from "../src/bom/types";
import { selectDefaultLocation } from "../src/location-selection";
import { radarImageMarkdown } from "../src/radar-markdown";
import {
  normalizeGeohash,
  summarizeCurrentWeather,
  WeatherBundle,
  warningMarkdown,
  warningSubtitle,
  warningTitle,
} from "../src/weather";

test("normalizeGeohash returns the six-character BoM location key", () => {
  assert.equal(normalizeGeohash("  qld-brisbane-r7hgdp9  "), "r7hgdp");
  assert.equal(normalizeGeohash("r7hgdp9"), "r7hgdp");
});

test("radar product grouping sorts fallback products by preferred range", () => {
  const sites = groupRadarSites([
    product("IDR663", "Mt Stapylton", "QLD", "256 km"),
    product("IDR661", "Mt Stapylton", "QLD", "64 km"),
    product("IDR662", "Mt Stapylton", "QLD", "128 km"),
  ]);

  assert.deepEqual(
    sites[0].products.map((item) => item.label),
    ["64 km", "128 km", "256 km"],
  );
});

test("radar overlay fallback maps specific products to base overlay product", () => {
  assert.equal(baseOverlayProductId("IDR66A"), "IDR663");
  assert.equal(baseOverlayProductId("IDR661"), "IDR663");
  assert.equal(baseOverlayProductId("IDR663"), "IDR663");
  assert.equal(baseOverlayProductId("IDR999"), null);
});

test("radar loop progress resets at the first frame and fills at the last", () => {
  const first = new PNG({ width: 100, height: 100 });
  const last = new PNG({ width: 100, height: 100 });
  first.data.fill(255);
  last.data.fill(255);

  addLoopProgressBar(first, 0, 7);
  addLoopProgressBar(last, 6, 7);

  assert.deepEqual([...first.data.subarray(0, 4)], [255, 255, 255, 255]);
  assert.deepEqual([...last.data.subarray(0, 4)], [255, 255, 255, 255]);
  assert.deepEqual(
    [...first.data.subarray(1_200 * 4, 1_200 * 4 + 4)],
    [75, 75, 75, 255],
  );
  assert.deepEqual(
    [...last.data.subarray(1_200 * 4, 1_200 * 4 + 4)],
    [75, 75, 75, 255],
  );
  assert.deepEqual(
    [...first.data.subarray(1_300 * 4, 1_300 * 4 + 4)],
    [75, 75, 75, 255],
  );
  assert.deepEqual(
    [...last.data.subarray(1_300 * 4, 1_300 * 4 + 4)],
    [255, 255, 255, 255],
  );
});

test("radar frame validation rejects malformed BoM cache payloads", () => {
  assert.equal(isRadarFrame({ url: "https://example.com/frame.png", file: "frame.png" }), true);
  assert.equal(isRadarFrame({ url: "https://example.com/frame.png", file: null }), false);
  assert.equal(isRadarFrame({ url: "https://example.com/frame.png", file: "frame.png", timestamp: null }), false);
});

test("radar image markdown uses an encoded file URL for Raycast detail images", () => {
  const markdown = radarImageMarkdown({
    alt: "IDR664 radar loop",
    path: "/Users/tongy/Library/Application Support/com.raycast-x.macos/extensions/australian-bom-weather/cache/gifs/IDR664/10-abc.gif",
    size: 430,
  });

  assert.equal(
    markdown,
    "![IDR664 radar loop](file:///Users/tongy/Library/Application%20Support/com.raycast-x.macos/extensions/australian-bom-weather/cache/gifs/IDR664/10-abc.gif?raycast-width=430&raycast-height=430)",
  );
});

test("warning formatting falls back cleanly when BoM fields are sparse", () => {
  const warning = {
    type: "Severe Weather Warning",
    phase: "Current",
    state: "QLD",
  };

  assert.equal(warningTitle(warning), "Severe Weather Warning");
  assert.equal(warningSubtitle(warning), "Current · QLD");
  assert.match(warningMarkdown(warning), /^# Severe Weather Warning/);
});

test("empty location store resolves to no default location", () => {
  assert.equal(selectDefaultLocation([], "r7hgdp"), null);
});

test("missing default location falls back to first saved location", () => {
  assert.deepEqual(
    selectDefaultLocation(
      [
        { geohash: "r7hgdp", name: "Brisbane" },
        { geohash: "r3gx2f", name: "Sydney" },
      ],
      "missing",
    ),
    { geohash: "r7hgdp", name: "Brisbane" },
  );
});

test("current weather summary tolerates empty hourly data", () => {
  const summary = summarizeCurrentWeather({
    ...weatherBundle(),
    hourly: { metadata: {}, data: [] },
    observation: {
      temp: 24,
      temp_feels_like: 23,
      wind: { direction: "SE", speed_kilometre: 12 },
      humidity: 65,
    },
  });

  assert.equal(summary.temp, 24);
  assert.equal(summary.feelsLike, 23);
  assert.equal(summary.rainChance, 40);
  assert.equal(summary.wind, "SE 12 km/h");
});

test("current weather summary tolerates empty daily data", () => {
  const summary = summarizeCurrentWeather({
    ...weatherBundle(),
    daily: { metadata: {}, data: [] },
  });

  assert.equal(summary.shortText, "Partly Cloudy");
  assert.equal(summary.temp, 25);
  assert.equal(summary.rainChance, 30);
});

function product(id: string, site: string, state: string, label: string) {
  return {
    id,
    site,
    state,
    label,
    loopUrl: `https://reg.bom.gov.au/products/${id}.loop.shtml`,
  };
}

function weatherBundle(): WeatherBundle {
  return {
    location: { geohash: "r7hgdp", name: "Brisbane" },
    observation: null,
    hourly: {
      metadata: {},
      data: [
        {
          time: new Date().toISOString(),
          temp: 25,
          temp_feels_like: 26,
          relative_humidity: 70,
          uv: 2,
          is_night: false,
          icon_descriptor: "partly_cloudy",
          rain: { chance: 30, amount: { min: 0, max: 1, units: "mm" } },
          wind: {
            direction: "E",
            speed_kilometre: 10,
            gust_speed_kilometre: 20,
          },
        },
      ],
    },
    daily: {
      metadata: {},
      data: [
        {
          date: new Date().toISOString(),
          temp_min: 19,
          temp_max: 28,
          short_text: "Possible shower",
          icon_descriptor: "shower",
          rain: { chance: 40, amount: { min: 0, max: 2, units: "mm" } },
        },
      ],
    },
    warnings: [],
  };
}
