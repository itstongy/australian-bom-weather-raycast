import { get } from "node:https";
import { join } from "node:path";
import {
  cacheDir,
  readFreshJson,
  readJsonFile,
  writeJsonFile,
} from "./bom/cache";

const FWO_BASE_URL = "https://reg.bom.gov.au/fwo";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 BOMWeatherRaycast/0.1";
const DAILY_TTL_MS = 60 * 60 * 1000;
const WARNINGS_TTL_MS = 30 * 60 * 1000;

const DOCUMENTED_FORECAST_LOCATIONS = [
  {
    geohash: "bom-qld-brisbane",
    id: "IDQ10095:QLD_PT001",
    name: "Brisbane",
    postcode: "4000",
    state: "QLD",
    productId: "IDQ10095",
    areaCode: "QLD_PT001",
    forecastRegion: "Brisbane",
  },
  {
    geohash: "bom-qld-brisbane-airport",
    id: "IDQ10095:QLD_PT050",
    name: "Brisbane Airport",
    postcode: "4008",
    state: "QLD",
    productId: "IDQ10095",
    areaCode: "QLD_PT050",
    forecastRegion: "Brisbane",
  },
] satisfies DocumentedForecastLocation[];

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

type DocumentedForecastLocation = LocationSearchResult & {
  productId: string;
  areaCode: string;
  forecastRegion: string;
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
  const documentedLocation = resolveDocumentedLocation(location);
  const [daily, warnings] = await Promise.all([
    fetchDaily(documentedLocation, options),
    fetchWarnings(documentedLocation, options).catch(() => []),
  ]);

  return {
    location: documentedLocation,
    observation: null,
    hourly: { metadata: daily.metadata, data: [] },
    daily: normalizeDailyForecast(daily),
    warnings: Array.isArray(warnings) ? warnings : [],
  };
}

export async function searchLocations(
  term: string,
): Promise<LocationSearchResult[]> {
  const query = term.trim();
  if (query.length < 2) return [];
  const normalizedQuery = query.toLocaleLowerCase("en-AU");
  return DOCUMENTED_FORECAST_LOCATIONS.filter((location) =>
    [location.name, location.state, location.postcode]
      .filter(Boolean)
      .some((value) =>
        value.toLocaleLowerCase("en-AU").includes(normalizedQuery),
      ),
  );
}

export async function fetchWarningsForLocation(
  location: WeatherLocation,
  options: FetchOptions = {},
): Promise<Warning[]> {
  return fetchWarnings(resolveDocumentedLocation(location), options);
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
    currentHour?.rain.amount.min ??
      today?.rain.amount.min ??
      today?.rain.amount.lower_range,
    currentHour?.rain.amount.max ??
      today?.rain.amount.max ??
      today?.rain.amount.upper_range,
    currentHour?.rain.amount.units ?? today?.rain.amount.units,
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
    currentHour?.icon_descriptor ?? today?.icon_descriptor,
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

function normalizeDailyForecast(value: DailyForecast): DailyForecast {
  return {
    metadata: value?.metadata ?? {},
    data: Array.isArray(value?.data) ? value.data.filter(isDailyDay) : [],
  };
}

function isDailyDay(value: unknown): value is DailyForecastDay {
  if (!value || typeof value !== "object") return false;
  return typeof (value as Partial<DailyForecastDay>).date === "string";
}

function resolveDocumentedLocation(
  location: WeatherLocation,
): DocumentedForecastLocation {
  const direct = DOCUMENTED_FORECAST_LOCATIONS.find(
    (item) => item.geohash === location.geohash || item.id === location.id,
  );
  if (direct) return direct;

  const normalizedName = location.name.toLocaleLowerCase("en-AU");
  const byName = DOCUMENTED_FORECAST_LOCATIONS.find(
    (item) => item.name.toLocaleLowerCase("en-AU") === normalizedName,
  );
  if (byName) return byName;

  throw new Error(
    `${location.name} is not available from the documented BoM forecast product catalogue yet. Search and save one of the listed BoM product locations.`,
  );
}

function parseForecastXml(
  xml: string,
  location: DocumentedForecastLocation,
): DailyForecast {
  const area = findAreaByCode(xml, location.areaCode);
  if (!area) {
    throw new Error(
      `${location.name} (${location.areaCode}) was not found in ${location.productId}.`,
    );
  }

  return {
    metadata: {
      issue_time: tagText(xml, "issue-time-utc"),
      next_issue_time: tagText(xml, "next-routine-issue-time-utc"),
      forecast_region: location.forecastRegion,
    },
    data:
      area
        .match(/<forecast-period\b[\s\S]*?<\/forecast-period>/g)
        ?.map(parseForecastPeriod) ?? [],
  };
}

function parseForecastPeriod(period: string): DailyForecastDay {
  const date = attr(period, "start-time-local") ?? new Date().toISOString();
  const rainRange = parseRainRange(elementText(period, "precipitation_range"));
  return {
    date,
    temp_min: numberOrUndefined(elementText(period, "air_temperature_minimum")),
    temp_max: numberOrUndefined(elementText(period, "air_temperature_maximum")),
    short_text: stripTrailingFullStop(textValue(period, "precis")),
    extended_text: stripTrailingFullStop(textValue(period, "precis")),
    icon_descriptor: iconDescriptorForCode(
      elementText(period, "forecast_icon_code"),
    ),
    rain: {
      chance: numberOrUndefined(
        textValue(period, "probability_of_precipitation"),
      ),
      amount: {
        min: rainRange?.min,
        max: rainRange?.max,
        units: "mm",
      },
    },
    fire_danger_category: { text: textValue(period, "fire_danger") },
  };
}

function parseWarningsXml(xml: string, state: string): Warning[] {
  const title = tagText(xml, "warning-title") ?? tagText(xml, "headline");
  if (!title) return [];
  return [
    {
      id: tagText(xml, "identifier"),
      issue_time: tagText(xml, "issue-time-utc"),
      expiry_time: tagText(xml, "expiry-time"),
      state,
      title,
      short_title: title,
      phase: tagText(xml, "phase"),
      type: tagText(xml, "warning-type"),
    },
  ];
}

function findAreaByCode(xml: string, areaCode: string) {
  const escaped = areaCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return xml.match(
    new RegExp(`<area\\b(?=[^>]*\\baac="${escaped}")[\\s\\S]*?<\\/area>`),
  )?.[0];
}

function tagText(xml: string, tag: string) {
  return decodeXml(
    xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1],
  );
}

function elementText(xml: string, type: string) {
  return typedTagText(xml, "element", type);
}

function textValue(xml: string, type: string) {
  return typedTagText(xml, "text", type);
}

function typedTagText(xml: string, tag: string, type: string) {
  const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return decodeXml(
    xml.match(
      new RegExp(
        `<${tag}\\b(?=[^>]*\\btype="${escaped}")[^>]*>([\\s\\S]*?)<\\/${tag}>`,
      ),
    )?.[1],
  );
}

function attr(xml: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return decodeXml(xml.match(new RegExp(`\\b${escaped}="([^"]*)"`))?.[1]);
}

function decodeXml(value?: string) {
  return value
    ?.replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function numberOrUndefined(value?: string) {
  if (!value) return undefined;
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

function parseRainRange(value?: string) {
  if (!value) return undefined;
  const numbers = [...value.matchAll(/\d+(?:\.\d+)?/g)].map((match) =>
    Number(match[0]),
  );
  if (numbers.length === 0) return undefined;
  return { min: numbers[0], max: numbers[numbers.length - 1] };
}

function stripTrailingFullStop(value?: string) {
  return value?.replace(/\.$/, "");
}

function iconDescriptorForCode(value?: string) {
  switch (value) {
    case "1":
      return "sunny";
    case "2":
    case "3":
      return "partly_cloudy";
    case "4":
    case "6":
      return "cloudy";
    case "8":
    case "9":
    case "10":
    case "11":
      return "shower";
    case "12":
      return "rain";
    case "13":
    case "14":
    case "15":
      return "storm";
    default:
      return undefined;
  }
}

function fetchDaily(
  location: DocumentedForecastLocation,
  options: FetchOptions,
) {
  return fetchCachedResponse<DailyForecast>(
    `weather-${location.productId}-${location.areaCode}-daily.json`,
    DAILY_TTL_MS,
    `${FWO_BASE_URL}/${location.productId}.xml`,
    (xml) => parseForecastXml(xml, location),
    options,
  );
}

function fetchWarnings(
  location: DocumentedForecastLocation,
  options: FetchOptions = {},
) {
  return fetchCachedResponse<Warning[]>(
    `weather-${location.state.toLowerCase()}-warnings.json`,
    WARNINGS_TTL_MS,
    `${FWO_BASE_URL}/ID${location.state[0]}21037.xml`,
    (xml) => parseWarningsXml(xml, location.state),
    options,
  ).catch(() => []);
}

async function fetchCachedResponse<T>(
  name: string,
  ttlMs: number,
  url: string,
  parse: (body: string) => T,
  options: FetchOptions = {},
): Promise<T> {
  const path = join(weatherCacheDir(), name);
  const fresh = options.forceRefresh
    ? null
    : readFreshJson<T>(path, ttlMs, isAnyValue);
  if (fresh) return fresh;
  const stale = readJsonFile<T>(path, isAnyValue);

  try {
    const value = parse(await httpGetText(url));
    writeJsonFile(path, value);
    return value;
  } catch (error) {
    if (stale) return stale;
    throw error;
  }
}

function httpGetText(url: string): Promise<string> {
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
        response.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        );
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
  if (trimmed.startsWith("bom-")) return trimmed;
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
