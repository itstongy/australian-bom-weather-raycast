import { get } from "node:https";
import { join } from "node:path";
import {
  cacheDir,
  readFreshJson,
  readJsonFile,
  writeJsonFile,
} from "./bom/cache";

const BASE_URL = "https://api.weather.bom.gov.au/v1/locations";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 BOMWeatherRaycast/0.1";
const OBSERVATION_TTL_MS = 10 * 60 * 1000;
const HOURLY_TTL_MS = 30 * 60 * 1000;
const DAILY_TTL_MS = 60 * 60 * 1000;
const WARNINGS_TTL_MS = 30 * 60 * 1000;

export type WeatherLocation = {
  geohash: string;
  name: string;
  state?: string;
  postcode?: string;
  id?: string;
};

export type LocationSearchResult = {
  geohash: string;
  id: string;
  name: string;
  postcode: string;
  state: string;
};

export type WeatherBundle = {
  location: WeatherLocation;
  observation: Observation | null;
  hourly: HourlyForecast;
  daily: DailyForecast;
  warnings: Warning[];
};

export type CurrentWeather = {
  title: string;
  subtitle: string;
  icon: string;
  temp: number;
  feelsLike: number;
  shortText: string;
  rainChance: number;
  rainRange: string;
  todayMin?: number;
  todayMax?: number;
  overnightMin?: number;
  wind: string;
  humidity?: number;
};

export type Observation = {
  issue_time?: string;
  observation_time?: string;
  temp?: number;
  temp_feels_like?: number;
  wind?: { direction?: string; speed_kilometre?: number };
  gust?: { speed_kilometre?: number };
  max_temp?: { value?: number };
  min_temp?: { value?: number };
  rain_since_9am?: number;
  humidity?: number;
  station?: { name?: string };
};

export type DailyForecast = {
  metadata: {
    issue_time?: string;
    next_issue_time?: string;
    forecast_region?: string;
  };
  data: DailyForecastDay[];
};

export type DailyForecastDay = {
  date: string;
  temp_max?: number;
  temp_min?: number;
  extended_text?: string;
  short_text?: string;
  icon_descriptor?: string;
  rain: {
    chance?: number;
    amount: {
      min?: number;
      max?: number;
      lower_range?: number;
      upper_range?: number;
      units?: string;
    };
  };
  uv?: { category?: string; max_index?: number };
  astronomical?: { sunrise_time?: string; sunset_time?: string };
  fire_danger_category?: { text?: string };
};

export type HourlyForecast = {
  metadata: { issue_time?: string };
  data: HourlyForecastHour[];
};

export type HourlyForecastHour = {
  time: string;
  temp: number;
  temp_feels_like: number;
  relative_humidity: number;
  uv: number;
  is_night: boolean;
  icon_descriptor: string;
  rain: {
    chance: number;
    amount: { min: number; max?: number; units?: string };
  };
  wind: {
    direction: string;
    speed_kilometre: number;
    gust_speed_kilometre: number;
  };
};

export type Warning = {
  area_id?: string;
  expiry_time?: string;
  id?: string;
  issue_time?: string;
  phase?: string;
  state?: string;
  title?: string;
  short_title?: string;
  type?: string;
  warning_group_type?: string;
};

type FetchOptions = {
  forceRefresh?: boolean;
};

export async function fetchWeatherBundle(
  location: WeatherLocation,
  options: FetchOptions = {},
): Promise<WeatherBundle> {
  const [observation, hourly, daily, warnings] = await Promise.all([
    fetchObservation(location.geohash, options).catch(() => null),
    fetchHourly(location.geohash, options),
    fetchDaily(location.geohash, options),
    fetchWarnings(location.geohash, options).catch(() => []),
  ]);

  return {
    location,
    observation,
    hourly: normalizeHourlyForecast(hourly),
    daily: normalizeDailyForecast(daily),
    warnings: Array.isArray(warnings) ? warnings : [],
  };
}

export async function searchLocations(
  term: string,
): Promise<LocationSearchResult[]> {
  const query = term.trim();
  if (query.length < 2) return [];
  const response = await httpGetJson<{ data: LocationSearchResult[] }>(
    `${BASE_URL}?search=${encodeURIComponent(query)}`,
  );
  return response.data ?? [];
}

export async function fetchWarningsForLocation(
  location: WeatherLocation,
  options: FetchOptions = {},
): Promise<Warning[]> {
  return fetchWarnings(location.geohash, options);
}

export function warningTitle(warning: Warning) {
  return (
    warning.title ?? warning.short_title ?? warning.type ?? "Weather Warning"
  );
}

export function warningSubtitle(warning: Warning) {
  return [warning.phase, warning.warning_group_type, warning.state]
    .filter(Boolean)
    .join(" · ");
}

export function warningMarkdown(warning: Warning) {
  const rows = [
    ["Title", warningTitle(warning)],
    ["Short title", warning.short_title],
    ["Type", warning.type],
    ["Group", warning.warning_group_type],
    ["Phase", warning.phase],
    ["State", warning.state],
    [
      "Issued",
      warning.issue_time ? formatDateTime(warning.issue_time) : undefined,
    ],
    [
      "Expires",
      warning.expiry_time ? formatDateTime(warning.expiry_time) : undefined,
    ],
    ["Area ID", warning.area_id],
    ["ID", warning.id],
  ];

  return [
    `# ${warningTitle(warning)}`,
    "",
    ...rows
      .filter(([, value]) => value)
      .map(([label, value]) => `- **${label}:** ${value}`),
  ].join("\n");
}

export function summarizeCurrentWeather(bundle: WeatherBundle): CurrentWeather {
  const currentHour = getCurrentHour(bundle.hourly.data);
  const today = bundle.daily.data[0];
  const tomorrow = bundle.daily.data[1];
  const fallbackTemp = today?.temp_max ?? today?.temp_min ?? 0;
  const temp = bundle.observation?.temp ?? currentHour?.temp ?? fallbackTemp;
  const feelsLike =
    bundle.observation?.temp_feels_like ?? currentHour?.temp_feels_like ?? temp;
  const shortText =
    today?.short_text ??
    descriptorToText(currentHour?.icon_descriptor, currentHour?.is_night);
  const rainRange = formatRainRange(
    currentHour?.rain.amount.min,
    currentHour?.rain.amount.max,
    currentHour?.rain.amount.units,
  );
  const windDirection =
    bundle.observation?.wind?.direction ?? currentHour?.wind.direction;
  const windSpeed =
    bundle.observation?.wind?.speed_kilometre ??
    currentHour?.wind.speed_kilometre;
  const gust =
    bundle.observation?.gust?.speed_kilometre ??
    currentHour?.wind.gust_speed_kilometre;
  const overnightMin = tomorrow?.temp_min;
  const max = bundle.observation?.max_temp?.value ?? today?.temp_max;
  const icon = iconForDescriptor(
    currentHour?.icon_descriptor,
    currentHour?.is_night,
  );
  const rainChance = currentHour?.rain.chance ?? today?.rain.chance ?? 0;

  return {
    title: `${icon} ${Math.round(temp)}°`,
    subtitle: `${shortText} · ${Math.round(feelsLike)}° feels · ${rainChance}% rain`,
    icon,
    temp,
    feelsLike,
    shortText,
    rainChance,
    rainRange,
    todayMin: today?.temp_min ?? undefined,
    todayMax: max,
    overnightMin: overnightMin ?? undefined,
    wind:
      windDirection && windSpeed != null
        ? `${windDirection} ${windSpeed} km/h${gust ? `, gust ${gust}` : ""}`
        : "Unavailable",
    humidity: bundle.observation?.humidity ?? currentHour?.relative_humidity,
  };
}

export function formatDay(day: DailyForecastDay) {
  const date = new Date(day.date);
  const label = date.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const temp = `${formatTemp(day.temp_min)} / ${formatTemp(day.temp_max)}`;
  const rain = `${day.rain?.chance ?? 0}% · ${formatRainRange(
    day.rain?.amount.min ?? day.rain?.amount.lower_range,
    day.rain?.amount.max ?? day.rain?.amount.upper_range,
    day.rain?.amount.units,
  )}`;
  return { label, temp, rain };
}

export function formatHour(hour: HourlyForecastHour) {
  const time = new Date(hour.time).toLocaleTimeString("en-AU", {
    hour: "numeric",
    minute: "2-digit",
  });
  return {
    time,
    temp: formatTemp(hour.temp),
    rain: `${hour.rain.chance}% · ${formatRainRange(hour.rain.amount.min, hour.rain.amount.max, hour.rain.amount.units)}`,
    wind: `${hour.wind.direction} ${hour.wind.speed_kilometre} km/h`,
  };
}

export function iconForDescriptor(descriptor?: string, isNight = false) {
  switch (descriptor) {
    case "sunny":
      return isNight ? "🌙" : "☀️";
    case "clear":
      return "🌙";
    case "mostly_sunny":
      return isNight ? "🌙" : "🌤️";
    case "partly_cloudy":
      return "⛅";
    case "cloudy":
      return "☁️";
    case "hazy":
      return "🌅";
    case "windy":
      return "🌬️";
    case "fog":
      return "🌫️";
    case "shower":
    case "light_shower":
    case "light_rain":
      return "🌦️";
    case "heavy_shower":
    case "rain":
      return "🌧️";
    case "frost":
    case "snow":
      return "❄️";
    case "storm":
      return "⛈️";
    case "cyclone":
      return "🌀";
    default:
      return "🌡️";
  }
}

function descriptorToText(descriptor?: string, isNight = false) {
  if (!descriptor) return "Weather";
  if (descriptor === "sunny" && isNight) return "Clear";
  if (descriptor === "mostly_sunny" && isNight) return "Mostly clear";
  return descriptor
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getCurrentHour(hours: HourlyForecastHour[]) {
  if (hours.length === 0) return undefined;
  const now = Date.now();
  return (
    [...hours].reverse().find((hour) => new Date(hour.time).getTime() <= now) ??
    hours.find((hour) => new Date(hour.time).getTime() >= now) ??
    hours[0]
  );
}

function normalizeHourlyForecast(value: HourlyForecast): HourlyForecast {
  return {
    metadata: value?.metadata ?? {},
    data: Array.isArray(value?.data) ? value.data.filter(isHourlyHour) : [],
  };
}

function normalizeDailyForecast(value: DailyForecast): DailyForecast {
  return {
    metadata: value?.metadata ?? {},
    data: Array.isArray(value?.data) ? value.data.filter(isDailyDay) : [],
  };
}

function isHourlyHour(value: unknown): value is HourlyForecastHour {
  if (!value || typeof value !== "object") return false;
  const hour = value as Partial<HourlyForecastHour>;
  return (
    typeof hour.time === "string" &&
    typeof hour.temp === "number" &&
    typeof hour.temp_feels_like === "number" &&
    typeof hour.relative_humidity === "number" &&
    typeof hour.icon_descriptor === "string" &&
    typeof hour.is_night === "boolean" &&
    typeof hour.rain?.chance === "number" &&
    typeof hour.rain?.amount?.min === "number" &&
    typeof hour.wind?.direction === "string" &&
    typeof hour.wind?.speed_kilometre === "number" &&
    typeof hour.wind?.gust_speed_kilometre === "number"
  );
}

function isDailyDay(value: unknown): value is DailyForecastDay {
  if (!value || typeof value !== "object") return false;
  return typeof (value as Partial<DailyForecastDay>).date === "string";
}

function fetchObservation(geohash: string, options: FetchOptions) {
  return fetchCachedResponse<{ data: Observation }>(
    `weather-${geohash}-observation.json`,
    OBSERVATION_TTL_MS,
    `${BASE_URL}/${geohash}/observations`,
    options,
  ).then((response) => response.data ?? null);
}

function fetchHourly(geohash: string, options: FetchOptions) {
  return fetchCachedResponse<HourlyForecast>(
    `weather-${geohash}-hourly.json`,
    HOURLY_TTL_MS,
    `${BASE_URL}/${geohash}/forecasts/hourly`,
    options,
  );
}

function fetchDaily(geohash: string, options: FetchOptions) {
  return fetchCachedResponse<DailyForecast>(
    `weather-${geohash}-daily.json`,
    DAILY_TTL_MS,
    `${BASE_URL}/${geohash}/forecasts/daily`,
    options,
  );
}

function fetchWarnings(geohash: string, options: FetchOptions = {}) {
  return fetchCachedResponse<{ data: Warning[] }>(
    `weather-${geohash}-warnings.json`,
    WARNINGS_TTL_MS,
    `${BASE_URL}/${geohash}/warnings`,
    options,
  ).then((response) => response.data ?? []);
}

async function fetchCachedResponse<T>(
  name: string,
  ttlMs: number,
  url: string,
  options: FetchOptions = {},
): Promise<T> {
  const path = join(weatherCacheDir(), name);
  const fresh = options.forceRefresh
    ? null
    : readFreshJson<T>(path, ttlMs, isAnyValue);
  if (fresh) return fresh;
  const stale = readJsonFile<T>(path, isAnyValue);

  try {
    const value = await httpGetJson<T>(url);
    writeJsonFile(path, value);
    return value;
  } catch (error) {
    if (stale) return stale;
    throw error;
  }
}

function httpGetJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      { headers: { "User-Agent": USER_AGENT } },
      (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`GET ${url} returned ${response.statusCode}`));
          response.resume();
          return;
        }

        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on("error", reject);
    request.setTimeout(15000, () =>
      request.destroy(new Error(`Timeout fetching ${url}`)),
    );
  });
}

function weatherCacheDir() {
  return join(cacheDir(), "weather");
}

export function normalizeGeohash(value: string) {
  const trimmed = value.trim();
  const parts = trimmed.split("-");
  return parts[parts.length - 1].slice(0, 6);
}

function formatTemp(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "–";
  return `${Math.round(value)}°`;
}

function formatRainRange(
  min?: number | null,
  max?: number | null,
  units = "mm",
) {
  if (min == null && max == null) return `0 ${units}`;
  if (max == null || min === max) return `${min ?? max} ${units}`;
  return `${min}-${max} ${units}`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isAnyValue<T>(value: unknown): value is T {
  return value !== undefined;
}
