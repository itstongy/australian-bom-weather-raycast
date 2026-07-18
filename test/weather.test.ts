import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setCacheBaseDir, writeJsonFile } from "../src/bom/cache";
import {
  fetchWarningDetail,
  fetchWeatherBundle,
  forcedWeatherRefreshSucceeded,
  currentWeatherMeta,
  isCurrentWarning,
  searchLocations,
  summarizeCurrentWeather,
  warningMarkdown,
  warningMessageToMarkdown,
  WEATHER_CACHE_POLICY,
} from "../src/weather";

test("warning detail HTML becomes readable, safe Raycast Markdown", () => {
  const markdown = warningMessageToMarkdown(`
    <script>alert("not weather")</script>
    <h2>Affected area</h2>
    <p>Locations include <strong>Brisbane</strong> &amp; Ipswich.</p>
    <ul><li>Move vehicles under cover</li><li>Call <a href="https://www.bom.gov.au/weather-services/severe-weather-knowledge-centre/">BoM advice</a></li></ul>
    <ul><li>Outer &ndash;<ul><li>Inner &mdash; &#x1F327;</li></ul></li></ul>
    <p>Invalid entities stay safe: &#x110000; &#55296; &hellip;</p>
    <a href="/products/IDQ21035.shtml">official warning</a>
    <a href="javascript:alert(1)">unsafe link</a>
  `);

  assert.match(markdown, /## Affected area/);
  assert.match(markdown, /\*\*Brisbane\*\* & Ipswich/);
  assert.match(markdown, /- Move vehicles under cover/);
  assert.match(markdown, /- Outer –\n\s+- Inner — 🌧/);
  assert.match(markdown, /&#x110000; &#55296; …/);
  assert.match(
    markdown,
    /\[BoM advice\]\(https:\/\/www\.bom\.gov\.au\/weather-services\/severe-weather-knowledge-centre\/\)/,
  );
  assert.doesNotMatch(markdown, /script|javascript|alert/);
  assert.match(
    markdown,
    /\[official warning\]\(https:\/\/www\.bom\.gov\.au\/products\/IDQ21035\.shtml\)/,
  );
});

test("warning Markdown preserves exact mixed ordered and unordered list hierarchy", () => {
  const markdown = warningMessageToMarkdown(
    '<ol start="2"><li>First &amp;<ul><li>Nested A</li><li>Nested B &ndash;<ol><li>Deep one</li><li>Deep two &hellip;</li></ol></li></ul></li><li>Second &copy;</li></ol>',
  );

  assert.deepEqual(markdown.split("\n"), [
    "2. First &",
    "   - Nested A",
    "   - Nested B –",
    "     1. Deep one",
    "     2. Deep two …",
    "3. Second ©",
  ]);
});

test("warning Markdown keeps paragraph-wrapped parent text around nested mixed lists", () => {
  const markdown = warningMessageToMarkdown(
    '<ol start="10"><li><p>Parent before</p><ul><li><p>Child paragraph</p><ol start="12"><li>Deep twelve</li><li>Deep thirteen</li></ol></li></ul><p>Parent after</p></li><li><p>Second parent</p></li></ol><p>Following sibling</p>',
  );

  assert.deepEqual(markdown.split("\n"), [
    "10. Parent before",
    "    - Child paragraph",
    "      12. Deep twelve",
    "      13. Deep thirteen",
    "    Parent after",
    "11. Second parent",
    "",
    "Following sibling",
  ]);
});

test("warning Markdown renders headings, mixed siblings, links, and entities exactly", () => {
  const markdown = warningMessageToMarkdown(
    '<h1>Heading &amp; news</h1><p>Before <a href="https://www.bom.gov.au/a?x=1&amp;y=2">safe link</a> after.</p><ul><li>One &ndash;</li></ul><h3>Next &copy;</h3><p>Tail &hellip;</p>',
  );

  assert.deepEqual(markdown.split("\n"), [
    "# Heading & news",
    "",
    "Before [safe link](https://www.bom.gov.au/a?x=1&y=2) after.",
    "",
    "- One –",
    "",
    "### Next ©",
    "",
    "Tail …",
  ]);
});

test("warning Markdown follows standard optional list-item and paragraph closing rules", () => {
  const markdown = warningMessageToMarkdown(
    "<ol start=8><li><p>Eight<ul><li>Nested A<li>Nested B</ul>After<li>Nine</ol><embed src=x><p>Still here",
  );

  assert.deepEqual(markdown.split("\n"), [
    "8. Eight",
    "   - Nested A",
    "   - Nested B",
    "   After",
    "9. Nine",
    "",
    "Still here",
  ]);
});

test("warning entity decoding cannot reactivate HTML, Markdown links, or unsafe protocols", () => {
  const markdown = warningMessageToMarkdown(
    '<p>&lt;script&gt;alert(1)&lt;/script&gt; &#91;x&#93;&#40;javascript:alert&#40;1&#41;&#41;</p><a href="java&#x73;cript:alert(1)">unsafe</a><script>discard me</script>',
  );

  assert.deepEqual(markdown.split("\n"), [
    "&lt;script&gt;alert(1)&lt;/script&gt; \\[x\\](javascript:alert(1))",
    "",
    "unsafe",
  ]);
  assert.doesNotMatch(markdown, /\[x\]\(javascript:/);
  assert.doesNotMatch(markdown, /discard me/);
});

test("warning sanitizer discards nested and malformed dangerous subtrees without swallowing following content", () => {
  const markdown = warningMessageToMarkdown(`
    <p>Before</p>
    <script>outer<script>inner</script>still outer</script>
    <style>css<object>object<iframe>frame</object>still discarded</style>
    <svg><math><script>mixed</script></math></svg>
    <embed src="ignored"><p>After</p>
  `);

  assert.deepEqual(markdown.split("\n"), ["Before", "", "After"]);
  assert.doesNotMatch(
    markdown,
    /outer|inner|css|object|frame|discarded|mixed|ignored/,
  );
});

test("warning sanitizer drops an unclosed dangerous tail and keeps encoded dangerous tags inert", () => {
  const unclosed = warningMessageToMarkdown(
    "<p>Safe before</p><iframe><p>untrusted tail</p><script>nested",
  );
  assert.equal(unclosed, "Safe before");

  const encoded = warningMessageToMarkdown(
    "<p>&lt;script&gt;visible&lt;/script&gt; &lt;iframe&gt;also visible&lt;/iframe&gt;</p><p>Safe after</p>",
  );
  assert.equal(
    encoded,
    "&lt;script&gt;visible&lt;/script&gt; &lt;iframe&gt;also visible&lt;/iframe&gt;\n\nSafe after",
  );
});

test("warning detail fetches the warning endpoint and includes its message", async () => {
  await withWeatherCache(async () => {
    let requestedUrl = "";
    const result = await fetchWarningDetail(
      { id: "QLD_FAKE_123", title: "Summary title" },
      {
        requestJson: async <T>(url: string) => {
          requestedUrl = url;
          return {
            data: {
              id: "QLD_FAKE_123",
              title: "Severe Weather Warning",
              message: "<p><strong>Heavy rainfall</strong> is expected.</p>",
            },
          } as T;
        },
      },
    );

    assert.equal(
      requestedUrl,
      "https://api.weather.bom.gov.au/v1/warnings/QLD_FAKE_123",
    );
    assert.equal(result.meta.source, "network");
    assert.match(warningMarkdown(result.warning), /\*\*Heavy rainfall\*\*/);
  });
});

test("weather fallback never pairs an over-limit payload with a fresh replacement age", async (context) => {
  const feeds = [
    {
      name: "observation",
      file: "observation",
      urlSuffix: "/observations",
      maxStaleMs: WEATHER_CACHE_POLICY.observation.maxStaleMs,
      value: (bundle: Awaited<ReturnType<typeof fetchWeatherBundle>>) =>
        bundle.observation?.temp,
    },
    {
      name: "hourly",
      file: "hourly",
      urlSuffix: "/forecasts/hourly",
      maxStaleMs: WEATHER_CACHE_POLICY.hourly.maxStaleMs,
      value: (bundle: Awaited<ReturnType<typeof fetchWeatherBundle>>) =>
        bundle.hourly.data[0]?.temp,
    },
    {
      name: "daily",
      file: "daily",
      urlSuffix: "/forecasts/daily",
      maxStaleMs: WEATHER_CACHE_POLICY.daily.maxStaleMs,
      value: (bundle: Awaited<ReturnType<typeof fetchWeatherBundle>>) =>
        bundle.daily.data[0]?.temp_max,
    },
    {
      name: "warnings",
      file: "warnings",
      urlSuffix: "/warnings",
      maxStaleMs: WEATHER_CACHE_POLICY.warnings.maxStaleMs,
      value: (bundle: Awaited<ReturnType<typeof fetchWeatherBundle>>) =>
        bundle.warnings[0]?.title,
    },
  ] as const;

  for (const feed of feeds) {
    await context.test(feed.name, async () => {
      await withWeatherCache(async (directory) => {
        const geohash = "r7rcce";
        const now = Date.now();
        const path = join(
          directory,
          "weather",
          `weather-${geohash}-${feed.file}.json`,
        );
        writeJsonFile(path, weatherRacePayload(feed.name, "old"));
        const tooOld = new Date(now - feed.maxStaleMs - 1_000);
        utimesSync(path, tooOld, tooOld);

        let replacementWritten = false;
        const bundle = await fetchWeatherBundle(
          { geohash, name: "Cache Race" },
          {
            forceRefresh: true,
            now: () => now,
            requestJson: async <T>(url: string) => {
              if (url.endsWith(feed.urlSuffix)) {
                writeJsonFile(path, weatherRacePayload(feed.name, "new"));
                const fresh = new Date(now);
                utimesSync(path, fresh, fresh);
                replacementWritten = true;
                throw new Error(`${feed.name} overlapping request failed`);
              }
              return fixtureRequest<T>(url);
            },
          },
        );

        assert.equal(replacementWritten, true);
        assert.equal(feed.value(bundle), feed.name === "warnings" ? "new" : 31);
        assert.equal(bundle.sources[feed.name].status, "stale");
        assert.equal(bundle.sources[feed.name].source, "cache");
        assert.equal(bundle.sources[feed.name].ageMs, 0);
      });
    });
  }
});

test("warning detail fallback uses replacement data and its matching timestamp", async () => {
  await withWeatherCache(async (directory) => {
    const id = "race-detail";
    const now = Date.now();
    const path = join(directory, "weather", `warning-${id}.json`);
    writeJsonFile(path, {
      data: { id, title: "old detail", message: "<p>old payload</p>" },
    });
    const tooOld = new Date(
      now - WEATHER_CACHE_POLICY.warnings.maxStaleMs - 1_000,
    );
    utimesSync(path, tooOld, tooOld);

    const result = await fetchWarningDetail(
      { id, title: "summary" },
      {
        forceRefresh: true,
        now: () => now,
        requestJson: async <T>() => {
          writeJsonFile(path, {
            data: {
              id,
              title: "new detail",
              message: "<p>replacement payload</p>",
            },
          });
          const fresh = new Date(now);
          utimesSync(path, fresh, fresh);
          throw new Error("overlapping detail request failed");
        },
      },
    );

    assert.equal(result.warning.title, "new detail");
    assert.match(result.warning.message ?? "", /replacement payload/);
    assert.doesNotMatch(result.warning.message ?? "", /old payload/);
    assert.equal(result.meta.status, "stale");
    assert.equal(result.meta.source, "cache");
    assert.equal(result.meta.ageMs, 0);
  });
});

test("a cache entry removed during failed revalidation is unavailable instead of reusing its initial snapshot", async () => {
  await withWeatherCache(async (directory) => {
    const location = { geohash: "r7mssg", name: "Missing Cache" };
    await fetchWeatherBundle(location, { requestJson: fixtureRequest });
    const observationPath = join(
      directory,
      "weather",
      "weather-r7mssg-observation.json",
    );

    const bundle = await fetchWeatherBundle(location, {
      forceRefresh: true,
      requestJson: async <T>(url: string) => {
        if (url.endsWith("/observations")) {
          rmSync(observationPath);
          throw new Error("observation failed after cache removal");
        }
        return fixtureRequest<T>(url);
      },
    });

    assert.equal(bundle.observation, null);
    assert.equal(bundle.sources.observation.status, "unavailable");
    assert.equal(bundle.sources.observation.source, "none");
    assert.equal(bundle.sources.observation.ageMs, undefined);
  });
});

test("failed warning requests are unavailable, not authoritative empty results", async () => {
  await withWeatherCache(async () => {
    const bundle = await fetchWeatherBundle(
      { geohash: "r7fbcd", name: "Unavailable" },
      { requestJson: failingRequest },
    );
    const summary = summarizeCurrentWeather(bundle);

    assert.equal(bundle.warnings.length, 0);
    assert.equal(bundle.sources.warnings.status, "unavailable");
    assert.match(bundle.sources.warnings.error ?? "", /offline/);
    assert.equal(summary.temp, null);
    assert.equal(summary.feelsLike, null);
    assert.equal(summary.rainChance, null);
    assert.equal(summary.rainRange, "Unavailable");
    assert.equal(summary.title, "🌡️ –");
    assert.equal(summary.subtitle, "Weather · – feels · – rain");
  });
});

test("malformed BoM payloads are rejected as unavailable", async () => {
  await withWeatherCache(async () => {
    const bundle = await fetchWeatherBundle(
      { geohash: "r7brkn", name: "Broken Payload" },
      {
        requestJson: async <T>() => ({ definitely: "not BoM data" }) as T,
      },
    );

    assert.equal(bundle.observation, null);
    assert.deepEqual(bundle.hourly.data, []);
    assert.deepEqual(bundle.daily.data, []);
    assert.equal(bundle.sources.observation.status, "unavailable");
    assert.equal(bundle.sources.hourly.status, "unavailable");
    assert.equal(bundle.sources.daily.status, "unavailable");
    assert.equal(bundle.sources.warnings.status, "unavailable");
    assert.match(bundle.sources.hourly.error ?? "", /invalid response/);
  });
});

test("forced refresh exposes stale cache fallback and never reports success", async () => {
  await withWeatherCache(async () => {
    const location = { geohash: "r7test", name: "Testville" };
    const initial = await fetchWeatherBundle(location, {
      requestJson: fixtureRequest,
    });
    assert.equal(forcedWeatherRefreshSucceeded(initial), true);

    const refreshed = await fetchWeatherBundle(location, {
      forceRefresh: true,
      requestJson: failingRequest,
    });

    assert.equal(refreshed.sources.observation.status, "stale");
    assert.equal(refreshed.sources.hourly.source, "cache");
    assert.equal(refreshed.sources.warnings.status, "stale");
    assert.equal(forcedWeatherRefreshSucceeded(refreshed), false);
    assert.match(refreshed.sources.daily.error ?? "", /offline/);
  });
});

test("warning stale limit is decided after a delayed failure with an inclusive exact boundary", async () => {
  await withWeatherCache(async (directory) => {
    const location = { geohash: "r7edge", name: "Boundary" };
    let now = Date.now();
    const warningPath = join(
      directory,
      "weather",
      "weather-r7edge-warnings.json",
    );
    const maxStaleMs = 30 * 60 * 1000;

    await fetchWeatherBundle(location, {
      requestJson: fixtureRequest,
      now: () => now,
    });

    const almostExpired = new Date(now - (maxStaleMs - 50));
    utimesSync(warningPath, almostExpired, almostExpired);
    const crossedBoundary = await fetchWeatherBundle(location, {
      forceRefresh: true,
      now: () => now,
      requestJson: async <T>(url: string) => {
        if (url.endsWith("/warnings")) {
          now += 100;
          throw new Error("delayed warning failure");
        }
        return fixtureRequest<T>(url);
      },
    });

    assert.equal(crossedBoundary.sources.warnings.status, "unavailable");
    assert.equal(crossedBoundary.sources.warnings.source, "none");
    assert.equal(crossedBoundary.sources.warnings.ageMs, maxStaleMs + 50);
    assert.deepEqual(crossedBoundary.warnings, []);

    const exactBoundary = new Date(now - maxStaleMs);
    utimesSync(warningPath, exactBoundary, exactBoundary);
    const atBoundary = await fetchWeatherBundle(location, {
      forceRefresh: true,
      now: () => now,
      requestJson: async <T>(url: string) => {
        if (url.endsWith("/warnings")) throw new Error("warning failure");
        return fixtureRequest<T>(url);
      },
    });

    assert.equal(atBoundary.sources.warnings.status, "stale");
    assert.equal(atBoundary.sources.warnings.source, "cache");
    assert.equal(atBoundary.sources.warnings.ageMs, maxStaleMs);
    assert.notEqual(atBoundary.warnings.length, 0);
  });
});

test("every weather feed enforces fresh and maximum-stale boundaries at decision time", async (context) => {
  const feeds = [
    {
      name: "observation",
      file: "observation",
      urlSuffix: "/observations",
      policy: WEATHER_CACHE_POLICY.observation,
    },
    {
      name: "hourly",
      file: "hourly",
      urlSuffix: "/forecasts/hourly",
      policy: WEATHER_CACHE_POLICY.hourly,
    },
    {
      name: "daily",
      file: "daily",
      urlSuffix: "/forecasts/daily",
      policy: WEATHER_CACHE_POLICY.daily,
    },
    {
      name: "warnings",
      file: "warnings",
      urlSuffix: "/warnings",
      policy: WEATHER_CACHE_POLICY.warnings,
    },
  ] as const;

  for (const feed of feeds) {
    await context.test(feed.name, async () => {
      await withWeatherCache(async (directory) => {
        const location = { geohash: "r7bmks", name: "Finite Limits" };
        let now = Date.now();
        const cachePath = join(
          directory,
          "weather",
          `weather-r7bmks-${feed.file}.json`,
        );
        await fetchWeatherBundle(location, {
          requestJson: fixtureRequest,
          now: () => now,
        });
        now += 1_000;

        const justFresh = new Date(now - (feed.policy.freshTtlMs - 1));
        utimesSync(cachePath, justFresh, justFresh);
        let targetRequests = 0;
        const fresh = await fetchWeatherBundle(location, {
          now: () => now,
          requestJson: async <T>(url: string) => {
            if (url.endsWith(feed.urlSuffix)) targetRequests += 1;
            return fixtureRequest<T>(url);
          },
        });
        assert.equal(targetRequests, 0, "inside fresh TTL must reuse cache");
        assert.equal(fresh.sources[feed.name].status, "fresh");
        assert.equal(fresh.sources[feed.name].source, "cache");
        assert.equal(
          fresh.sources[feed.name].ageMs,
          feed.policy.freshTtlMs - 1,
        );

        const freshBoundary = new Date(now - feed.policy.freshTtlMs);
        utimesSync(cachePath, freshBoundary, freshBoundary);
        const refreshed = await fetchWeatherBundle(location, {
          now: () => now,
          requestJson: async <T>(url: string) => {
            if (url.endsWith(feed.urlSuffix)) targetRequests += 1;
            return fixtureRequest<T>(url);
          },
        });
        assert.equal(targetRequests, 1, "fresh TTL boundary must revalidate");
        assert.equal(refreshed.sources[feed.name].source, "network");

        const staleBoundary = new Date(now - feed.policy.maxStaleMs);
        utimesSync(cachePath, staleBoundary, staleBoundary);
        const stale = await fetchWeatherBundle(location, {
          forceRefresh: true,
          now: () => now,
          requestJson: async <T>(url: string) => {
            if (url.endsWith(feed.urlSuffix))
              throw new Error(`${feed.name} failed`);
            return fixtureRequest<T>(url);
          },
        });
        assert.equal(stale.sources[feed.name].status, "stale");
        assert.equal(stale.sources[feed.name].source, "cache");
        assert.equal(stale.sources[feed.name].ageMs, feed.policy.maxStaleMs);

        const almostTooOld = new Date(now - (feed.policy.maxStaleMs - 50));
        utimesSync(cachePath, almostTooOld, almostTooOld);
        const unavailable = await fetchWeatherBundle(location, {
          forceRefresh: true,
          now: () => now,
          requestJson: async <T>(url: string) => {
            if (url.endsWith(feed.urlSuffix)) {
              now += 100;
              throw new Error(`delayed ${feed.name} failure`);
            }
            return fixtureRequest<T>(url);
          },
        });
        assert.equal(unavailable.sources[feed.name].status, "unavailable");
        assert.equal(unavailable.sources[feed.name].source, "none");
        assert.equal(
          unavailable.sources[feed.name].ageMs,
          feed.policy.maxStaleMs + 50,
        );
      });
    });
  }
});

test("actual zero weather values remain distinct from unavailable values", async () => {
  await withWeatherCache(async () => {
    const bundle = await fetchWeatherBundle(
      { geohash: "r7zerm", name: "Zero Point" },
      { requestJson: fixtureRequest },
    );
    const summary = summarizeCurrentWeather(bundle);

    assert.equal(summary.temp, 0);
    assert.equal(summary.feelsLike, 0);
    assert.equal(summary.rainChance, 0);
    assert.equal(summary.rainRange, "0 mm");
    assert.equal(summary.humidity, 0);
    assert.equal(summary.wind, "S 0 km/h, gust 0");
    assert.equal(summary.title, "🌤️ 0°");
    assert.match(summary.subtitle, /0° feels · 0% rain/);
  });
});

test("expired warnings are excluded while current and invalid-date warnings remain visible", async () => {
  const now = Date.parse("2026-07-18T12:00:00Z");
  assert.equal(
    isCurrentWarning({ expiry_time: "2026-07-18T11:59:59Z" }, now),
    false,
  );
  assert.equal(
    isCurrentWarning({ expiry_time: "2026-07-18T12:00:01Z" }, now),
    true,
  );
  assert.equal(isCurrentWarning({ expiry_time: "not-a-date" }, now), true);
  assert.equal(isCurrentWarning({}, now), true);
});

test("location search rejects an already-aborted request without starting HTTP", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(searchLocations("Brisbane", controller.signal), {
    name: "AbortError",
  });
});

test("location search aborts an HTTP request after it has started", async () => {
  const controller = new AbortController();
  const search = searchLocations("Brisbane", controller.signal);
  controller.abort();

  await assert.rejects(search, { name: "AbortError" });
});

test("weather boundaries normalize valid geohashes and reject traversal before request or cache access", async () => {
  await withWeatherCache(async () => {
    let requests = 0;
    const normalized = await fetchWeatherBundle(
      { geohash: " R7TEST ", name: "Normalized" },
      {
        requestJson: async <T>(url: string) => {
          requests += 1;
          assert.match(url, /\/locations\/r7test\//);
          return fixtureRequest<T>(url);
        },
      },
    );
    assert.equal(normalized.location.geohash, "r7test");
    assert.equal(requests, 4);

    requests = 0;
    await assert.rejects(
      fetchWeatherBundle(
        { geohash: "../../outside", name: "Traversal" },
        {
          requestJson: async <T>() => {
            requests += 1;
            return {} as T;
          },
        },
      ),
      /exactly six valid characters/,
    );
    assert.equal(requests, 0);
  });
});

test("hostile nested weather values and metadata are never accepted as fresh", async () => {
  const hostileBySuffix: Record<string, unknown> = {
    "/observations": {
      metadata: { issue_time: "not-a-date" },
      data: { temp: 24, wind: { speed_kilometre: Number.POSITIVE_INFINITY } },
    },
    "/forecasts/hourly": {
      metadata: { issue_time: new Date().toISOString() },
      data: [
        {
          time: "invalid",
          temp: Number.NaN,
          temp_feels_like: 20,
          relative_humidity: 101,
          uv: 0,
          is_night: false,
          icon_descriptor: "sunny",
          rain: { chance: 0, amount: { min: 0 } },
          wind: { direction: "N", speed_kilometre: 1, gust_speed_kilometre: 2 },
        },
      ],
    },
    "/forecasts/daily": {
      metadata: { issue_time: new Date().toISOString() },
      data: [{ date: "invalid", astronomical: { sunrise_time: "bad" } }],
    },
    "/warnings": { data: [{ id: "", title: "" }] },
  };

  for (const [hostileSuffix, hostile] of Object.entries(hostileBySuffix)) {
    await withWeatherCache(async () => {
      const bundle = await fetchWeatherBundle(
        { geohash: "r7bbdx", name: "Hostile" },
        {
          requestJson: async <T>(url: string) => {
            if (url.endsWith(hostileSuffix)) return hostile as T;
            return fixtureRequest<T>(url);
          },
        },
      );
      const source = hostileSuffix.endsWith("observations")
        ? bundle.sources.observation
        : hostileSuffix.endsWith("hourly")
          ? bundle.sources.hourly
          : hostileSuffix.endsWith("daily")
            ? bundle.sources.daily
            : bundle.sources.warnings;
      assert.equal(source.status, "unavailable", hostileSuffix);
      assert.notEqual(source.source, "network", hostileSuffix);
    });
  }
});

test("malformed fresh cache entries are discarded instead of reported as fresh", async () => {
  await withWeatherCache(async (directory) => {
    writeJsonFile(join(directory, "weather", "weather-r7cchx-hourly.json"), {
      metadata: { issue_time: new Date().toISOString() },
      data: [{ time: "bad", temp: Number.NaN }],
    });
    const bundle = await fetchWeatherBundle(
      { geohash: "r7cchx", name: "Bad cache" },
      { requestJson: failingRequest },
    );
    assert.equal(bundle.sources.hourly.status, "unavailable");
    assert.equal(bundle.sources.hourly.source, "none");
    assert.match(bundle.sources.hourly.error ?? "", /offline/);
  });
});

test("BoM null warning data is a verified empty warning result", async () => {
  await withWeatherCache(async () => {
    const bundle = await fetchWeatherBundle(
      { geohash: "r7wrnx", name: "No warnings" },
      {
        requestJson: async <T>(url: string) => {
          if (url.endsWith("/warnings")) return { data: null } as T;
          return fixtureRequest<T>(url);
        },
      },
    );
    assert.deepEqual(bundle.warnings, []);
    assert.equal(bundle.sources.warnings.status, "fresh");
    assert.equal(bundle.sources.warnings.source, "network");
  });
});

test("combined current provenance is conservative across every feed supplying displayed values", async () => {
  await withWeatherCache(async () => {
    const location = { geohash: "r7prvx", name: "Provenance" };
    await fetchWeatherBundle(location, { requestJson: fixtureRequest });
    const refreshed = await fetchWeatherBundle(location, {
      forceRefresh: true,
      requestJson: async <T>(url: string) => {
        if (url.endsWith("/forecasts/hourly"))
          throw new Error("hourly offline");
        return fixtureRequest<T>(url);
      },
    });
    assert.equal(refreshed.sources.observation.status, "fresh");
    assert.equal(refreshed.sources.hourly.status, "stale");
    assert.equal(currentWeatherMeta(refreshed).status, "stale");
  });
});

async function fixtureRequest<T>(url: string): Promise<T> {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  if (url.endsWith("/observations")) {
    return {
      metadata: {
        issue_time: new Date().toISOString(),
        observation_time: new Date().toISOString(),
      },
      data: {
        observation_time: new Date().toISOString(),
        temp: 0,
        temp_feels_like: 0,
        humidity: 0,
        wind: { direction: "S", speed_kilometre: 0 },
        gust: { speed_kilometre: 0 },
      },
    } as T;
  }
  if (url.endsWith("/forecasts/hourly")) {
    return {
      metadata: { issue_time: new Date().toISOString() },
      data: [
        {
          time: new Date().toISOString(),
          temp: 0,
          temp_feels_like: 0,
          relative_humidity: 0,
          uv: 0,
          is_night: false,
          icon_descriptor: "mostly_sunny",
          rain: { chance: 0, amount: { min: 0, max: 0, units: "mm" } },
          wind: {
            direction: "S",
            speed_kilometre: 0,
            gust_speed_kilometre: 0,
          },
        },
      ],
    } as T;
  }
  if (url.endsWith("/forecasts/daily")) {
    return {
      metadata: { issue_time: new Date().toISOString() },
      data: [
        {
          date: new Date().toISOString(),
          temp_min: 0,
          temp_max: 0,
          short_text: "Cold and dry",
          rain: { chance: 0, amount: { min: 0, max: 0, units: "mm" } },
        },
      ],
    } as T;
  }
  if (url.endsWith("/warnings")) {
    return {
      data: [
        { id: "current", title: "Current warning", expiry_time: future },
        { id: "expired", title: "Expired warning", expiry_time: past },
      ],
    } as T;
  }
  throw new Error(`Unexpected fixture URL: ${url}`);
}

function weatherRacePayload(
  feed: "observation" | "hourly" | "daily" | "warnings",
  marker: "old" | "new",
) {
  const timestamp = "2026-07-18T00:00:00.000Z";
  const temperature = marker === "old" ? 11 : 31;
  if (feed === "observation") {
    return {
      metadata: { issue_time: timestamp, observation_time: timestamp },
      data: { temp: temperature },
    };
  }
  if (feed === "hourly") {
    return {
      metadata: { issue_time: timestamp },
      data: [
        {
          time: timestamp,
          temp: temperature,
          temp_feels_like: temperature,
          relative_humidity: 50,
          uv: 0,
          is_night: false,
          icon_descriptor: "sunny",
          rain: { chance: 0, amount: { min: 0, max: 0, units: "mm" } },
          wind: {
            direction: "N",
            speed_kilometre: 10,
            gust_speed_kilometre: 15,
          },
        },
      ],
    };
  }
  if (feed === "daily") {
    return {
      metadata: { issue_time: timestamp },
      data: [{ date: timestamp, temp_min: 10, temp_max: temperature }],
    };
  }
  return {
    data: [
      {
        id: `${marker}-warning`,
        title: marker,
        expiry_time: "2099-01-01T00:00:00.000Z",
      },
    ],
  };
}

async function failingRequest<T>(): Promise<T> {
  throw new Error("BoM is offline for this test");
}

async function withWeatherCache(run: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "bom-weather-test-"));
  setCacheBaseDir(directory);
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
