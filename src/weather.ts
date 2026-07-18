import { join } from "node:path";
import {
  cacheDir,
  JsonFileSnapshot,
  readJsonFileSnapshot,
  writeJsonFile,
} from "./bom/cache";
import { httpGetBuffer } from "./bom/http";

const API_URL = "https://api.weather.bom.gov.au/v1";
const BASE_URL = `${API_URL}/locations`;
const WEATHER_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const GEOHASH_PATTERN = /^[0-9bcdefghjkmnpqrstuvwxyz]{6}$/;
export const WEATHER_CACHE_POLICY = {
  observation: { freshTtlMs: 10 * 60 * 1000, maxStaleMs: 60 * 60 * 1000 },
  hourly: { freshTtlMs: 30 * 60 * 1000, maxStaleMs: 6 * 60 * 60 * 1000 },
  daily: { freshTtlMs: 60 * 60 * 1000, maxStaleMs: 24 * 60 * 60 * 1000 },
  warnings: { freshTtlMs: 5 * 60 * 1000, maxStaleMs: 30 * 60 * 1000 },
} as const;
const WARNING_DETAIL_TTL_MS = 5 * 60 * 1000;
const WARNING_DETAIL_MAX_STALE_MS = WEATHER_CACHE_POLICY.warnings.maxStaleMs;

export type WeatherDataStatus = "fresh" | "stale" | "unavailable";
export type WeatherDataSource = "network" | "cache" | "none";

export type WeatherDataMeta = {
  status: WeatherDataStatus;
  source: WeatherDataSource;
  fetchedAt?: string;
  ageMs?: number;
  error?: string;
  issueTime?: string;
};

export type WeatherBundleSources = {
  observation: WeatherDataMeta;
  hourly: WeatherDataMeta;
  daily: WeatherDataMeta;
  warnings: WeatherDataMeta;
};

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
  sources: WeatherBundleSources;
  expiredWarningCount: number;
};

export type CurrentWeather = {
  title: string;
  subtitle: string;
  icon: string;
  temp: number | null;
  feelsLike: number | null;
  shortText: string;
  rainChance: number | null;
  rainRange: string;
  todayMin?: number;
  todayMax?: number;
  overnightMin?: number;
  wind: string;
  humidity?: number;
};

export type Observation = {
  issue_time?: string | null;
  observation_time?: string | null;
  temp?: number | null;
  temp_feels_like?: number | null;
  wind?: {
    direction?: string | null;
    speed_kilometre?: number | null;
  };
  gust?: { speed_kilometre?: number | null };
  max_temp?: { value?: number | null };
  min_temp?: { value?: number | null };
  rain_since_9am?: number | null;
  humidity?: number | null;
  station?: { name?: string | null };
};

type ObservationResponse = {
  metadata: {
    issue_time?: string;
    observation_time?: string;
    response_timestamp?: string;
  };
  data: Observation;
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
  temp_max?: number | null;
  temp_min?: number | null;
  extended_text?: string | null;
  short_text?: string | null;
  icon_descriptor?: string | null;
  rain?: {
    chance?: number | null;
    amount?: {
      min?: number | null;
      max?: number | null;
      lower_range?: number | null;
      upper_range?: number | null;
      units?: string | null;
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
  area_id?: string | null;
  expiry_time?: string | null;
  id?: string | null;
  issue_time?: string | null;
  phase?: string | null;
  state?: string | null;
  title?: string | null;
  short_title?: string | null;
  type?: string | null;
  warning_group_type?: string | null;
  message?: string | null;
};

export type WarningsResult = {
  warnings: Warning[];
  meta: WeatherDataMeta;
  expiredCount: number;
};

export type WarningDetailResult = {
  warning: Warning;
  meta: WeatherDataMeta;
};

export type FetchOptions = {
  forceRefresh?: boolean;
  signal?: AbortSignal;
  /** Used by tests and alternate runtimes; production defaults to the BoM HTTPS client. */
  requestJson?: <T>(url: string, signal?: AbortSignal) => Promise<T>;
  /** Deterministic clock hook for cache-boundary tests. */
  now?: () => number;
};

type CachedResponse<T> = { data: T | null; meta: WeatherDataMeta };

export async function fetchWeatherBundle(
  location: WeatherLocation,
  options: FetchOptions = {},
): Promise<WeatherBundle> {
  const geohash = requireGeohash(location.geohash);
  const normalizedLocation = { ...location, geohash };
  const [observation, hourly, daily, warningResult] = await Promise.all([
    fetchObservation(geohash, options),
    fetchHourly(geohash, options),
    fetchDaily(geohash, options),
    fetchWarnings(geohash, options),
  ]);

  return {
    location: normalizedLocation,
    observation: observation.data,
    hourly: normalizeHourlyForecast(hourly.data),
    daily: normalizeDailyForecast(daily.data),
    warnings: warningResult.warnings,
    sources: {
      observation: observation.meta,
      hourly: hourly.meta,
      daily: daily.meta,
      warnings: warningResult.meta,
    },
    expiredWarningCount: warningResult.expiredCount,
  };
}

export async function searchLocations(
  term: string,
  signal?: AbortSignal,
): Promise<LocationSearchResult[]> {
  const query = term.trim();
  if (query.length < 2) return [];
  const response = await httpGetJson<{ data: LocationSearchResult[] }>(
    `${BASE_URL}?search=${encodeURIComponent(query)}`,
    signal,
  );
  if (!isRecord(response) || !Array.isArray(response.data)) {
    throw new Error("BoM returned an invalid location search response.");
  }
  return response.data.filter(isLocationSearchResult).map((result) => ({
    ...result,
    geohash: result.geohash.slice(0, 6).toLowerCase(),
  }));
}

export async function fetchWarningsForLocation(
  location: WeatherLocation,
  options: FetchOptions = {},
): Promise<WarningsResult> {
  return fetchWarnings(requireGeohash(location.geohash), options);
}

export async function fetchWarningDetail(
  summary: Warning,
  options: FetchOptions = {},
): Promise<WarningDetailResult> {
  if (!summary.id) {
    return {
      warning: summary,
      meta: unavailableMeta("This warning has no BoM detail identifier."),
    };
  }

  const response = await fetchCachedResponse<{ data?: Warning } | Warning>(
    `warning-${safeCacheName(summary.id)}.json`,
    WARNING_DETAIL_TTL_MS,
    `${API_URL}/warnings/${encodeURIComponent(summary.id)}`,
    options,
    WARNING_DETAIL_MAX_STALE_MS,
    isWarningDetailResponse,
  );
  if (!response.data) {
    throw new Error(response.meta.error ?? "Could not load warning details.");
  }
  const payload = response.data;
  const detail =
    "data" in payload && payload.data && typeof payload.data === "object"
      ? payload.data
      : (payload as Warning);
  return { warning: { ...summary, ...detail }, meta: response.meta };
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
    warning.message ? warningMessageToMarkdown(warning.message) : "",
    "",
    "## Warning information",
    "",
    ...rows
      .filter(([, value]) => value)
      .map(([label, value]) => `- **${label}:** ${value}`),
  ].join("\n");
}

export function warningMessageToMarkdown(html: string) {
  if (!html.trim()) return "No detailed warning message was returned by BoM.";
  const value = renderWarningHtml(parseWarningHtml(html));
  return value || "No detailed warning message was returned by BoM.";
}

export function summarizeCurrentWeather(bundle: WeatherBundle): CurrentWeather {
  const currentHour = getCurrentHour(bundle.hourly.data);
  const today = bundle.daily.data[0];
  const tomorrow = bundle.daily.data[1];
  const fallbackTemp = firstFinite(today?.temp_max, today?.temp_min);
  const temp = firstFinite(
    bundle.observation?.temp,
    currentHour?.temp,
    fallbackTemp,
  );
  const feelsLike = firstFinite(
    bundle.observation?.temp_feels_like,
    currentHour?.temp_feels_like,
    temp,
  );
  const shortText =
    today?.short_text ??
    descriptorToText(currentHour?.icon_descriptor, currentHour?.is_night);
  const rainRange = formatRainRange(
    firstFinite(
      currentHour?.rain.amount.min,
      today?.rain?.amount?.min,
      today?.rain?.amount?.lower_range,
    ),
    firstFinite(
      currentHour?.rain.amount.max,
      today?.rain?.amount?.max,
      today?.rain?.amount?.upper_range,
    ),
    currentHour?.rain.amount.units ?? today?.rain?.amount?.units ?? undefined,
  );
  const windDirection =
    bundle.observation?.wind?.direction ?? currentHour?.wind.direction;
  const windSpeed = firstFinite(
    bundle.observation?.wind?.speed_kilometre,
    currentHour?.wind.speed_kilometre,
  );
  const gust = firstFinite(
    bundle.observation?.gust?.speed_kilometre,
    currentHour?.wind.gust_speed_kilometre,
  );
  const overnightMin = firstFinite(tomorrow?.temp_min) ?? undefined;
  const max =
    firstFinite(bundle.observation?.max_temp?.value, today?.temp_max) ??
    undefined;
  const icon = iconForDescriptor(
    currentHour?.icon_descriptor,
    currentHour?.is_night,
  );
  const rainChance = firstFinite(currentHour?.rain.chance, today?.rain?.chance);

  const tempText = formatTemp(temp);
  const feelsLikeText = formatTemp(feelsLike);
  const rainChanceText = formatPercent(rainChance);

  return {
    title: `${icon} ${tempText}`,
    subtitle: `${shortText} · ${feelsLikeText} feels · ${rainChanceText} rain`,
    icon,
    temp,
    feelsLike,
    shortText,
    rainChance,
    rainRange,
    todayMin: firstFinite(today?.temp_min) ?? undefined,
    todayMax: max,
    overnightMin: overnightMin ?? undefined,
    wind:
      windDirection && windSpeed != null
        ? `${windDirection} ${windSpeed} km/h${gust != null ? `, gust ${gust}` : ""}`
        : "Unavailable",
    humidity:
      firstFinite(
        bundle.observation?.humidity,
        currentHour?.relative_humidity,
      ) ?? undefined,
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
  const rain = `${formatPercent(day.rain?.chance)} · ${formatRainRange(
    day.rain?.amount?.min ?? day.rain?.amount?.lower_range,
    day.rain?.amount?.max ?? day.rain?.amount?.upper_range,
    day.rain?.amount?.units ?? undefined,
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

export function iconForDescriptor(descriptor?: string | null, isNight = false) {
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

function descriptorToText(descriptor?: string | null, isNight = false) {
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

function normalizeHourlyForecast(value: HourlyForecast | null): HourlyForecast {
  return {
    metadata: value?.metadata ?? {},
    data: Array.isArray(value?.data) ? value.data.filter(isHourlyHour) : [],
  };
}

function normalizeDailyForecast(value: DailyForecast | null): DailyForecast {
  return {
    metadata: value?.metadata ?? {},
    data: Array.isArray(value?.data) ? value.data.filter(isDailyDay) : [],
  };
}

function isHourlyHour(value: unknown): value is HourlyForecastHour {
  if (!isRecord(value)) return false;
  const hour = value as Partial<HourlyForecastHour>;
  return (
    isDate(hour.time) &&
    isFiniteNumber(hour.temp) &&
    isFiniteNumber(hour.temp_feels_like) &&
    isFiniteNumber(hour.uv) &&
    isFiniteNumber(hour.relative_humidity) &&
    hour.relative_humidity >= 0 &&
    hour.relative_humidity <= 100 &&
    typeof hour.icon_descriptor === "string" &&
    typeof hour.is_night === "boolean" &&
    isRecord(hour.rain) &&
    isFiniteNumber(hour.rain.chance) &&
    hour.rain.chance >= 0 &&
    hour.rain.chance <= 100 &&
    isRecord(hour.rain.amount) &&
    isFiniteNumber(hour.rain.amount.min) &&
    hour.rain.amount.min >= 0 &&
    isOptionalNonNegativeNumber(hour.rain.amount.max) &&
    isOptionalString(hour.rain.amount.units) &&
    isRecord(hour.wind) &&
    isNonEmptyString(hour.wind.direction) &&
    isFiniteNumber(hour.wind.speed_kilometre) &&
    hour.wind.speed_kilometre >= 0 &&
    isFiniteNumber(hour.wind.gust_speed_kilometre) &&
    hour.wind.gust_speed_kilometre >= 0
  );
}

function isDailyDay(value: unknown): value is DailyForecastDay {
  if (!value || typeof value !== "object") return false;
  const day = value as Partial<DailyForecastDay>;
  return (
    isDate(day.date) &&
    isOptionalFiniteNumber(day.temp_max) &&
    isOptionalFiniteNumber(day.temp_min) &&
    isOptionalString(day.extended_text) &&
    isOptionalString(day.short_text) &&
    isOptionalString(day.icon_descriptor) &&
    (day.rain == null ||
      (isRecord(day.rain) &&
        isOptionalPercentage(day.rain.chance) &&
        (day.rain.amount == null ||
          (isRecord(day.rain.amount) &&
            isOptionalNonNegativeNumber(day.rain.amount.min) &&
            isOptionalNonNegativeNumber(day.rain.amount.max) &&
            isOptionalNonNegativeNumber(day.rain.amount.lower_range) &&
            isOptionalNonNegativeNumber(day.rain.amount.upper_range) &&
            isOptionalString(day.rain.amount.units))))) &&
    (day.uv == null ||
      (isRecord(day.uv) &&
        isOptionalString(day.uv.category) &&
        isOptionalNonNegativeNumber(day.uv.max_index))) &&
    (day.astronomical == null ||
      (isRecord(day.astronomical) &&
        isOptionalDate(day.astronomical.sunrise_time) &&
        isOptionalDate(day.astronomical.sunset_time))) &&
    (day.fire_danger_category == null ||
      (isRecord(day.fire_danger_category) &&
        isOptionalString(day.fire_danger_category.text)))
  );
}

function fetchObservation(geohash: string, options: FetchOptions) {
  return fetchCachedResponse<ObservationResponse>(
    `weather-${geohash}-observation.json`,
    WEATHER_CACHE_POLICY.observation.freshTtlMs,
    `${BASE_URL}/${geohash}/observations`,
    options,
    WEATHER_CACHE_POLICY.observation.maxStaleMs,
    isObservationResponse,
  ).then((response) => {
    const metadata = response.data?.metadata;
    return {
      data: response.data
        ? {
            ...response.data.data,
            issue_time: metadata?.issue_time,
            observation_time: metadata?.observation_time,
          }
        : null,
      meta: withIssueTime(
        response.meta,
        metadata?.observation_time ?? metadata?.issue_time,
      ),
    };
  });
}

function fetchHourly(geohash: string, options: FetchOptions) {
  return fetchCachedResponse<HourlyForecast>(
    `weather-${geohash}-hourly.json`,
    WEATHER_CACHE_POLICY.hourly.freshTtlMs,
    `${BASE_URL}/${geohash}/forecasts/hourly`,
    options,
    WEATHER_CACHE_POLICY.hourly.maxStaleMs,
    isHourlyForecastResponse,
  ).then((response) => ({
    ...response,
    meta: withIssueTime(response.meta, response.data?.metadata.issue_time),
  }));
}

function fetchDaily(geohash: string, options: FetchOptions) {
  return fetchCachedResponse<DailyForecast>(
    `weather-${geohash}-daily.json`,
    WEATHER_CACHE_POLICY.daily.freshTtlMs,
    `${BASE_URL}/${geohash}/forecasts/daily`,
    options,
    WEATHER_CACHE_POLICY.daily.maxStaleMs,
    isDailyForecastResponse,
  ).then((response) => ({
    ...response,
    meta: withIssueTime(response.meta, response.data?.metadata.issue_time),
  }));
}

async function fetchWarnings(
  geohash: string,
  options: FetchOptions = {},
): Promise<WarningsResult> {
  const response = await fetchCachedResponse<{ data: Warning[] | null }>(
    `weather-${geohash}-warnings.json`,
    WEATHER_CACHE_POLICY.warnings.freshTtlMs,
    `${BASE_URL}/${geohash}/warnings`,
    options,
    WEATHER_CACHE_POLICY.warnings.maxStaleMs,
    isWarningsResponse,
  );
  const allWarnings = response.data?.data ?? [];
  const warnings = allWarnings.filter(isCurrentWarning);
  return {
    warnings,
    meta: response.meta,
    expiredCount: allWarnings.length - warnings.length,
  };
}

async function fetchCachedResponse<T>(
  name: string,
  ttlMs: number,
  url: string,
  options: FetchOptions,
  maxStaleMs: number,
  validate: (value: unknown) => value is T = isAnyValue,
): Promise<CachedResponse<T>> {
  if (!Number.isFinite(maxStaleMs) || maxStaleMs < ttlMs) {
    throw new Error(
      "Weather max-stale policy must be finite and at least its fresh TTL.",
    );
  }
  const path = join(weatherCacheDir(), name);
  const initialNow = options.now?.() ?? Date.now();
  const cached = readJsonFileSnapshot<T>(path, validate);
  const initialAge = snapshotAgeMs(cached, initialNow);
  if (
    !options.forceRefresh &&
    cached &&
    initialAge != null &&
    initialAge >= 0 &&
    initialAge < ttlMs
  ) {
    return {
      data: cached.data,
      meta: cacheMeta("fresh", cached, initialNow),
    };
  }

  try {
    const value = await (options.requestJson ?? httpGetJson)<T>(
      url,
      options.signal,
    );
    if (!validate(value)) {
      throw new Error(`BoM returned an invalid response for ${url}`);
    }
    writeJsonFile(path, value);
    const completedAt = options.now?.() ?? Date.now();
    return {
      data: value,
      meta: {
        status: "fresh",
        source: "network",
        fetchedAt: new Date(completedAt).toISOString(),
        ageMs: 0,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    const message = errorMessage(error);
    const fallbackNow = options.now?.() ?? Date.now();
    const fallback = readJsonFileSnapshot<T>(path, validate);
    const fallbackAge = snapshotAgeMs(fallback, fallbackNow);
    if (fallback && fallbackAge != null && fallbackAge <= maxStaleMs) {
      return {
        data: fallback.data,
        meta: {
          ...cacheMeta("stale", fallback, fallbackNow),
          error: message,
        },
      };
    }
    return { data: null, meta: unavailableMeta(message, fallbackAge) };
  }
}

async function httpGetJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const buffer = await httpGetBuffer(url, {
    signal,
    maxBytes: WEATHER_MAX_RESPONSE_BYTES,
  });
  try {
    return JSON.parse(buffer.toString("utf8")) as T;
  } catch {
    throw new Error(`BoM returned invalid JSON for ${url}`);
  }
}

function weatherCacheDir() {
  return join(cacheDir(), "weather");
}

export function normalizeGeohash(value: string) {
  const suffix = value.trim().toLowerCase().split("-").at(-1) ?? "";
  return requireGeohash(suffix.slice(0, 6));
}

export function isCurrentWarning(warning: Warning, now = Date.now()) {
  if (!warning.expiry_time) return true;
  const expiry = new Date(warning.expiry_time).getTime();
  return Number.isNaN(expiry) || expiry > now;
}

export function weatherDataLabel(meta: WeatherDataMeta) {
  const age = formatAge(meta.ageMs);
  if (meta.status === "unavailable")
    return `Unavailable${age ? ` · cached ${age}` : ""}`;
  return meta.status === "stale"
    ? `Stale${age ? ` · ${age}` : ""}`
    : age || "Current";
}

export function weatherIssueTime(bundle: WeatherBundle) {
  return currentWeatherMeta(bundle).issueTime;
}

export function currentWeatherMeta(bundle: WeatherBundle) {
  return mergeWeatherMeta(
    currentWeatherFeedMeta(bundle).map((entry) => entry.meta),
  );
}

export function currentWeatherFeedMeta(bundle: WeatherBundle) {
  const entries: Array<{ label: string; meta: WeatherDataMeta }> = [];
  if (bundle.observation) {
    entries.push({ label: "Observation", meta: bundle.sources.observation });
  }
  if (getCurrentHour(bundle.hourly.data)) {
    entries.push({ label: "Hourly", meta: bundle.sources.hourly });
  }
  if (bundle.daily.data.length) {
    entries.push({ label: "Daily", meta: bundle.sources.daily });
  }
  if (!entries.length) {
    return [
      { label: "Observation", meta: bundle.sources.observation },
      { label: "Hourly", meta: bundle.sources.hourly },
      { label: "Daily", meta: bundle.sources.daily },
    ];
  }
  return entries;
}

export function forcedWeatherRefreshSucceeded(bundle: WeatherBundle) {
  return (
    [
      bundle.sources.observation,
      bundle.sources.hourly,
      bundle.sources.daily,
      bundle.sources.warnings,
    ] as WeatherDataMeta[]
  ).every((meta) => meta.status === "fresh" && meta.source === "network");
}

function formatTemp(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "–";
  return `${Math.round(value)}°`;
}

function firstFinite(...values: Array<number | null | undefined>) {
  return (
    values.find(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    ) ?? null
  );
}

function formatRainRange(
  min?: number | null,
  max?: number | null,
  units = "mm",
) {
  if (min == null && max == null) return "Unavailable";
  if (max == null || min === max) return `${min ?? max} ${units}`;
  return `${min}-${max} ${units}`;
}

function formatPercent(value?: number | null) {
  return value == null || !Number.isFinite(value)
    ? "–"
    : `${Math.round(value)}%`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isObservationResponse(value: unknown): value is ObservationResponse {
  if (
    !isRecord(value) ||
    !isWeatherMetadata(value.metadata, true) ||
    !isRecord(value.data)
  )
    return false;
  const observation = value.data;
  const structurallyValid =
    isOptionalFiniteNumber(observation.temp) &&
    isOptionalFiniteNumber(observation.temp_feels_like) &&
    isOptionalPercentage(observation.humidity) &&
    isOptionalNonNegativeNumber(observation.rain_since_9am) &&
    isOptionalWind(observation.wind) &&
    isOptionalSpeedValue(observation.gust) &&
    isOptionalMeasurement(observation.max_temp) &&
    isOptionalMeasurement(observation.min_temp) &&
    isOptionalStation(observation.station);
  const hasWeatherValue =
    [
      observation.temp,
      observation.temp_feels_like,
      observation.humidity,
      observation.rain_since_9am,
    ].some(isFiniteNumber) ||
    (isRecord(observation.wind) &&
      (isNonEmptyString(observation.wind.direction) ||
        isFiniteNumber(observation.wind.speed_kilometre)));
  return structurallyValid && hasWeatherValue;
}

function isHourlyForecastResponse(value: unknown): value is HourlyForecast {
  return (
    isRecord(value) &&
    isWeatherMetadata(value.metadata, true) &&
    Array.isArray(value.data) &&
    value.data.length > 0 &&
    value.data.every(isHourlyHour)
  );
}

function isDailyForecastResponse(value: unknown): value is DailyForecast {
  return (
    isRecord(value) &&
    isWeatherMetadata(value.metadata, true) &&
    Array.isArray(value.data) &&
    value.data.length > 0 &&
    value.data.every(isDailyDay)
  );
}

function isWarningsResponse(
  value: unknown,
): value is { data: Warning[] | null } {
  return (
    isRecord(value) &&
    (value.data === null ||
      (Array.isArray(value.data) && value.data.every(isWarningValue)))
  );
}

function isWarningDetailResponse(
  value: unknown,
): value is { data?: Warning } | Warning {
  if (!isRecord(value)) return false;
  return !("data" in value)
    ? isWarningValue(value)
    : isWarningValue(value.data);
}

function isWarningValue(value: unknown): value is Warning {
  if (!isRecord(value)) return false;
  const stringsValid = [
    value.area_id,
    value.id,
    value.phase,
    value.state,
    value.title,
    value.short_title,
    value.type,
    value.warning_group_type,
    value.message,
  ].every(isOptionalString);
  const datesValid = [value.expiry_time, value.issue_time].every(
    isOptionalDate,
  );
  const meaningfulId = isNonEmptyString(value.id);
  const meaningfulContent = [
    value.title,
    value.short_title,
    value.type,
    value.message,
  ].some(isNonEmptyString);
  return stringsValid && datesValid && meaningfulId && meaningfulContent;
}

function isLocationSearchResult(value: unknown): value is LocationSearchResult {
  if (!isRecord(value)) return false;
  return (
    typeof value.geohash === "string" &&
    /^[0-9bcdefghjkmnpqrstuvwxyz]{6,}$/i.test(value.geohash) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    typeof value.postcode === "string" &&
    isNonEmptyString(value.state)
  );
}

function isOptionalString(value: unknown) {
  return value == null || typeof value === "string";
}

function isOptionalFiniteNumber(value: unknown) {
  return value == null || (typeof value === "number" && Number.isFinite(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDate(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isOptionalDate(value: unknown) {
  return value == null || isDate(value);
}

function isOptionalPercentage(value: unknown) {
  return value == null || (isFiniteNumber(value) && value >= 0 && value <= 100);
}

function isOptionalNonNegativeNumber(value: unknown) {
  return value == null || (isFiniteNumber(value) && value >= 0);
}

function isWeatherMetadata(value: unknown, requireIssueTime: boolean) {
  if (!isRecord(value)) return false;
  if (requireIssueTime && !isDate(value.issue_time)) return false;
  return (
    isOptionalDate(value.issue_time) &&
    isOptionalDate(value.observation_time) &&
    isOptionalDate(value.response_timestamp) &&
    isOptionalDate(value.next_issue_time) &&
    isOptionalString(value.forecast_region)
  );
}

function isOptionalWind(value: unknown) {
  return (
    value == null ||
    (isRecord(value) &&
      isOptionalString(value.direction) &&
      isOptionalNonNegativeNumber(value.speed_kilometre))
  );
}

function isOptionalSpeedValue(value: unknown) {
  return (
    value == null ||
    (isRecord(value) && isOptionalNonNegativeNumber(value.speed_kilometre))
  );
}

function isOptionalMeasurement(value: unknown) {
  return (
    value == null ||
    (isRecord(value) &&
      isOptionalFiniteNumber(value.value) &&
      isOptionalDate(value.time))
  );
}

function isOptionalStation(value: unknown) {
  return (
    value == null ||
    (isRecord(value) &&
      isOptionalString(value.name) &&
      isOptionalString(value.bom_id) &&
      isOptionalNonNegativeNumber(value.distance))
  );
}

function cacheMeta(
  status: Extract<WeatherDataStatus, "fresh" | "stale">,
  snapshot: JsonFileSnapshot<unknown>,
  now: number,
): WeatherDataMeta {
  const ageMs = snapshotAgeMs(snapshot, now);
  return {
    status,
    source: "cache",
    ageMs: ageMs ?? undefined,
    fetchedAt: ageMs == null ? undefined : new Date(now - ageMs).toISOString(),
  };
}

function withIssueTime(meta: WeatherDataMeta, issueTime?: string) {
  return issueTime && isDate(issueTime) ? { ...meta, issueTime } : meta;
}

function mergeWeatherMeta(metas: WeatherDataMeta[]): WeatherDataMeta {
  if (!metas.length)
    return unavailableMeta("No weather feeds supplied the displayed values.");
  const status: WeatherDataStatus = metas.some(
    (meta) => meta.status === "unavailable",
  )
    ? "unavailable"
    : metas.some((meta) => meta.status === "stale")
      ? "stale"
      : "fresh";
  const source: WeatherDataSource = metas.some((meta) => meta.source === "none")
    ? "none"
    : metas.some((meta) => meta.source === "cache")
      ? "cache"
      : "network";
  const ages = metas
    .map((meta) => meta.ageMs)
    .filter((age): age is number => age != null && Number.isFinite(age));
  const issueTimes = [
    ...new Set(metas.map((meta) => meta.issueTime).filter(Boolean)),
  ];
  return {
    status,
    source,
    ageMs: ages.length ? Math.max(...ages) : undefined,
    error:
      metas
        .map((meta) => meta.error)
        .filter(Boolean)
        .join("; ") || undefined,
    issueTime: issueTimes.length === 1 ? issueTimes[0] : undefined,
  };
}

function unavailableMeta(
  error: string,
  ageMs?: number | null,
): WeatherDataMeta {
  return {
    status: "unavailable",
    source: "none",
    error,
    ageMs: ageMs ?? undefined,
  };
}

function snapshotAgeMs(
  snapshot: JsonFileSnapshot<unknown> | null,
  now = Date.now(),
) {
  return snapshot ? Math.max(0, now - snapshot.mtimeMs) : null;
}

function formatAge(ageMs?: number) {
  if (ageMs == null || !Number.isFinite(ageMs)) return "";
  const minutes = Math.max(0, Math.round(ageMs / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.round(minutes / 60);
  return `${hours}h old`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function safeCacheName(value: string) {
  return value.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 160);
}

function requireGeohash(value: unknown) {
  if (typeof value !== "string") throw new Error("Invalid weather geohash.");
  const normalized = value.trim().toLowerCase();
  if (!GEOHASH_PATTERN.test(normalized)) {
    throw new Error("Weather geohash must be exactly six valid characters.");
  }
  return normalized;
}

type WarningHtmlNode = {
  type: "root" | "element" | "text";
  tag?: string;
  value?: string;
  attributes: Record<string, string>;
  children: WarningHtmlNode[];
};

const WARNING_VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const WARNING_DISCARDED_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
]);

function parseWarningHtml(html: string): WarningHtmlNode {
  const root = warningElement("root");
  const stack = [root];
  const discardStack: string[] = [];
  let cursor = 0;

  while (cursor < html.length) {
    if (html.startsWith("<!--", cursor)) {
      const commentEnd = html.indexOf("-->", cursor + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    if (html[cursor] !== "<") {
      const nextTag = html.indexOf("<", cursor);
      const end = nextTag < 0 ? html.length : nextTag;
      if (!discardStack.length) {
        appendWarningText(stack.at(-1)!, html.slice(cursor, end));
      }
      cursor = end;
      continue;
    }

    const tagEnd = findWarningTagEnd(html, cursor);
    if (tagEnd < 0) {
      if (!discardStack.length) {
        appendWarningText(stack.at(-1)!, html.slice(cursor));
      }
      break;
    }
    const rawTag = html.slice(cursor, tagEnd + 1);
    const closing = rawTag.match(/^<\s*\/\s*([a-z][a-z0-9:-]*)/i);
    if (closing) {
      const tag = closing[1].toLowerCase();
      if (discardStack.length) {
        const discardIndex = discardStack.lastIndexOf(tag);
        if (discardIndex >= 0) discardStack.splice(discardIndex);
        cursor = tagEnd + 1;
        continue;
      }
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tag === tag) {
          stack.splice(index);
          break;
        }
      }
      cursor = tagEnd + 1;
      continue;
    }

    const opening = rawTag.match(/^<\s*([a-z][a-z0-9:-]*)/i);
    if (!opening) {
      // A malformed tag is content, not trusted markup.
      if (!discardStack.length) appendWarningText(stack.at(-1)!, rawTag);
      cursor = tagEnd + 1;
      continue;
    }
    const tag = opening[1].toLowerCase();
    const selfClosing = /\/\s*>$/.test(rawTag) || WARNING_VOID_TAGS.has(tag);
    if (discardStack.length) {
      if (WARNING_DISCARDED_TAGS.has(tag) && !selfClosing) {
        discardStack.push(tag);
      }
      cursor = tagEnd + 1;
      continue;
    }
    if (WARNING_DISCARDED_TAGS.has(tag)) {
      if (!selfClosing) discardStack.push(tag);
      cursor = tagEnd + 1;
      continue;
    }

    implicitlyCloseWarningTags(stack, tag);

    const node = warningElement(
      tag,
      parseWarningAttributes(rawTag, opening[0].length),
    );
    stack.at(-1)!.children.push(node);
    if (!selfClosing) stack.push(node);
    cursor = tagEnd + 1;
  }
  return root;
}

function implicitlyCloseWarningTags(
  stack: WarningHtmlNode[],
  openingTag: string,
) {
  const blockClosesParagraph =
    openingTag === "ul" ||
    openingTag === "ol" ||
    /^h[1-6]$/.test(openingTag) ||
    isWarningBlockTag(openingTag);
  if (blockClosesParagraph) closeOpenWarningTag(stack, "p");
  if (openingTag === "p") closeOpenWarningTag(stack, "p");
  if (openingTag !== "li") return;

  let listIndex = -1;
  for (let index = stack.length - 1; index > 0; index -= 1) {
    if (stack[index].tag === "ul" || stack[index].tag === "ol") {
      listIndex = index;
      break;
    }
  }
  for (let index = stack.length - 1; index > listIndex; index -= 1) {
    if (stack[index].tag === "li") {
      stack.splice(index);
      return;
    }
  }
}

function closeOpenWarningTag(stack: WarningHtmlNode[], tag: string) {
  for (let index = stack.length - 1; index > 0; index -= 1) {
    if (stack[index].tag === tag) {
      stack.splice(index);
      return;
    }
  }
}

function warningElement(
  tag: string,
  attributes: Record<string, string> = {},
): WarningHtmlNode {
  return {
    type: tag === "root" ? "root" : "element",
    tag,
    attributes,
    children: [],
  };
}

function appendWarningText(parent: WarningHtmlNode, value: string) {
  if (!value) return;
  parent.children.push({ type: "text", value, attributes: {}, children: [] });
}

function findWarningTagEnd(html: string, start: number) {
  let quote = "";
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function parseWarningAttributes(rawTag: string, nameEnd: number) {
  const attributes: Record<string, string> = {};
  const source = rawTag.slice(nameEnd, -1).replace(/\/\s*$/, "");
  const pattern =
    /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function renderWarningHtml(root: WarningHtmlNode) {
  return renderWarningFlow(root.children, 0)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderWarningFlow(nodes: WarningHtmlNode[], indent: number): string {
  const blocks: string[] = [];
  let inline: WarningHtmlNode[] = [];
  const flushInline = () => {
    const value = renderWarningInline(inline);
    if (value) blocks.push(indentBlock(value, indent));
    inline = [];
  };

  for (const node of nodes) {
    const tag = node.tag ?? "";
    if (tag === "ul" || tag === "ol") {
      flushInline();
      blocks.push(renderWarningList(node, indent));
    } else if (/^h[1-6]$/.test(tag)) {
      flushInline();
      const level = Number(tag.slice(1));
      const heading = renderWarningInline(node.children);
      if (heading) blocks.push(`${"#".repeat(level)} ${heading}`);
    } else if (isWarningBlockTag(tag)) {
      flushInline();
      const value = renderWarningFlow(node.children, indent);
      if (value) blocks.push(value);
    } else if (tag === "hr") {
      flushInline();
      blocks.push(`${" ".repeat(indent)}---`);
    } else {
      inline.push(node);
    }
  }
  flushInline();
  return blocks.filter(Boolean).join("\n\n");
}

function renderWarningList(list: WarningHtmlNode, indent: number) {
  const items = list.children.filter((node) => node.tag === "li");
  let orderedValue = parseWarningListStart(list.attributes.start);
  return items
    .map((item) => {
      const marker = list.tag === "ol" ? `${orderedValue++}.` : "-";
      return renderWarningListItem(item, marker, indent);
    })
    .filter(Boolean)
    .join("\n");
}

function parseWarningListStart(value?: string) {
  if (!value || !/^-?\d+$/.test(value.trim())) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 1;
}

function renderWarningListItem(
  item: WarningHtmlNode,
  marker: string,
  indent: number,
) {
  const contentIndent = indent + marker.length + 1;
  const lines: string[] = [];
  let inline: WarningHtmlNode[] = [];
  let hasMarker = false;
  const flushInline = () => {
    const value = renderWarningInline(inline);
    inline = [];
    if (!value) return;
    const valueLines = value.split("\n");
    if (!hasMarker) {
      lines.push(`${" ".repeat(indent)}${marker} ${valueLines[0]}`);
      hasMarker = true;
      for (const line of valueLines.slice(1)) {
        lines.push(`${" ".repeat(contentIndent)}${line}`);
      }
    } else {
      for (const line of valueLines) {
        lines.push(`${" ".repeat(contentIndent)}${line}`);
      }
    }
  };

  for (const node of item.children) {
    if (node.tag === "ul" || node.tag === "ol") {
      flushInline();
      if (!hasMarker) {
        lines.push(`${" ".repeat(indent)}${marker}`);
        hasMarker = true;
      }
      lines.push(renderWarningList(node, contentIndent));
    } else {
      inline.push(node);
    }
  }
  flushInline();
  if (!hasMarker) lines.push(`${" ".repeat(indent)}${marker}`);
  return lines.join("\n");
}

function renderWarningInline(nodes: WarningHtmlNode[]): string {
  const value = nodes.map(renderWarningInlineNode).join("");
  return value
    .split("\n")
    .map((line) => line.replace(/[\t\r ]+/g, " ").trim())
    .filter(
      (line, index, lines) => line || (index > 0 && index < lines.length - 1),
    )
    .join("\n")
    .trim();
}

function renderWarningInlineNode(node: WarningHtmlNode): string {
  if (node.type === "text")
    return escapeWarningText(decodeHtmlEntities(node.value ?? ""));
  const tag = node.tag ?? "";
  if (tag === "br") return "\n";
  if (tag === "strong" || tag === "b") {
    const content = renderWarningInline(node.children);
    return content ? `**${content}**` : "";
  }
  if (tag === "em" || tag === "i") {
    const content = renderWarningInline(node.children);
    return content ? `_${content}_` : "";
  }
  if (tag === "a") {
    const label =
      warningPlainText(node).replace(/\s+/g, " ").trim() || "BoM link";
    const href = safeWarningLink(node.attributes.href ?? "");
    const safeLabel = escapeWarningText(label);
    return href ? `[${safeLabel}](${href})` : safeLabel;
  }
  const content = renderWarningInline(node.children);
  return isWarningBlockTag(tag) ? ` ${content} ` : content;
}

function warningPlainText(node: WarningHtmlNode): string {
  if (node.type === "text") return decodeHtmlEntities(node.value ?? "");
  return node.children.map(warningPlainText).join("");
}

function isWarningBlockTag(tag: string) {
  return new Set([
    "address",
    "article",
    "aside",
    "blockquote",
    "dd",
    "div",
    "dl",
    "dt",
    "footer",
    "header",
    "main",
    "nav",
    "p",
    "section",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
  ]).has(tag);
}

function indentBlock(value: string, indent: number) {
  if (!indent) return value;
  const prefix = " ".repeat(indent);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function escapeWarningText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([`*_!]|\[|\])/g, "\\$1");
}

function safeWarningLink(value: string) {
  const decoded = decodeHtmlEntities(value).trim();
  try {
    const url = new URL(decoded, "https://www.bom.gov.au");
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString().replace(/\)/g, "%29")
      : null;
  } catch {
    return null;
  }
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
    ndash: "–",
    mdash: "—",
    hellip: "…",
    copy: "©",
    reg: "®",
  };
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (entity, code: string) => {
      if (code[0] !== "#") return named[code.toLowerCase()] ?? entity;
      const numeric =
        code[1]?.toLowerCase() === "x"
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      return Number.isInteger(numeric) &&
        numeric >= 0 &&
        numeric <= 0x10ffff &&
        !(numeric >= 0xd800 && numeric <= 0xdfff)
        ? String.fromCodePoint(numeric)
        : entity;
    },
  );
}
